import express from "express";
import {getConfigVariable} from "./util.js";
import FireflyService from "./FireflyService.js";
import {createProviderFromConfig} from "./providers/registry.js";
import {Server} from "socket.io";
import * as http from "http";
import Queue from "queue";
import JobList from "./JobList.js";

import ExpenseAccountMatcher from "./ExpenseAccountMatcher.js";

export default class App {
    #PORT;
    #ENABLE_UI;

    #firefly;
    #provider;
    #expenseAccountMatcher;

    #server;
    #io;
    #express;

    #queue;
    #jobList;


    constructor() {
        this.#PORT = getConfigVariable("PORT", '3000');
        this.#ENABLE_UI = getConfigVariable("ENABLE_UI", 'false') === 'true';
    }

    async run() {
        this.#firefly = new FireflyService();
        this.#provider = createProviderFromConfig();
        this.#expenseAccountMatcher = new ExpenseAccountMatcher(this.#provider, this.#firefly);

        this.#queue = new Queue({
            timeout: 30 * 1000,
            concurrency: 1,
            autostart: true
        });

        this.#queue.addEventListener('start', job => console.log('Job started', job))
        this.#queue.addEventListener('success', event => console.log('Job success', event.job))
        this.#queue.addEventListener('error', (err, job) => console.error('Job error', {err, job}))
        this.#queue.addEventListener('timeout', event => console.log('Job timeout', event.job))

        this.#express = express();
        this.#server = http.createServer(this.#express)
        this.#io = new Server(this.#server)

        this.#jobList = new JobList();
        this.#jobList.on('job created', data => this.#io.emit('job created', data));
        this.#jobList.on('job updated', data => this.#io.emit('job updated', data));

        this.#express.use(express.json());

        if (this.#ENABLE_UI) {
            this.#express.use('/', express.static('public'))
        }

        this.#express.get('/api/transactions', this.#getTransactions.bind(this))
        this.#express.post('/api/classify', this.#postClassify.bind(this))
        this.#express.post('/api/classify/batch', this.#postClassifyBatch.bind(this))
        this.#express.post('/webhook', this.#onWebhook.bind(this))

        this.#server.listen(this.#PORT, async () => {
            console.log(`Application running on port ${this.#PORT}`);
        });

        this.#io.on('connection', socket => {
            console.log('connected');
            socket.emit('jobs', Array.from(this.#jobList.getJobs().values()));
        })
    }

    #onWebhook(req, res) {
        try {
            console.info("Webhook triggered");
            this.#handleWebhook(req, res);
            res.send("Queued");
        } catch (e) {
            console.error(e)
            res.status(400).send(e.message);
        }
    }

    #handleWebhook(req, res) {
        // TODO: validate auth

        if (req.body?.trigger !== "STORE_TRANSACTION") {
            throw new WebhookException("trigger is not STORE_TRANSACTION. Request will not be processed");
        }

        if (req.body?.response !== "TRANSACTIONS") {
            throw new WebhookException("trigger is not TRANSACTION. Request will not be processed");
        }

        if (!req.body?.content?.id) {
            throw new WebhookException("Missing content.id");
        }

        if (req.body?.content?.transactions?.length === 0) {
            throw new WebhookException("No transactions are available in content.transactions");
        }

        if (req.body.content.transactions[0].type !== "withdrawal") {
            throw new WebhookException("content.transactions[0].type has to be 'withdrawal'. Transaction will be ignored.");
        }

        if (req.body.content.transactions[0].category_id !== null) {
            throw new WebhookException("content.transactions[0].category_id is already set. Transaction will be ignored.");
        }

        if (!req.body.content.transactions[0].description) {
            throw new WebhookException("Missing content.transactions[0].description");
        }

        if (!req.body.content.transactions[0].destination_name) {
            throw new WebhookException("Missing content.transactions[0].destination_name");
        }

        const transactionId = req.body.content.id;
        const transactions = req.body.content.transactions;
        const destinationName = transactions[0].destination_name;
        const description = transactions[0].description

        const job = this.#jobList.createJob({
            transactionId,
            destinationName,
            description
        });

        this.#enqueueClassificationJob({
            job,
            transactionId,
            transactions,
            destinationName,
            description
        });
    }

    async #getTransactions(req, res) {
        try {
            console.log("Fetching transactions...")
            const limit = this.#parsePositiveInt(req.query?.limit, 10);
            const page = this.#parsePositiveInt(req.query?.page, 1);
            const type = typeof req.query?.type === "string" && req.query.type.trim().length > 0 ? req.query.type : "default";

            const result = await this.#firefly.getTransactions({limit, page, type});

            console.log("Transactions fetched successfully", JSON.stringify(result))

            const items = [];
            if (Array.isArray(result?.data)) {
                result.data.forEach(entry => {
                    const splits = entry?.attributes?.transactions ?? [];
                    splits.forEach((split, idx) => {
                        const splitId = split?.internal_reference ?? split?.internal_id ?? split?.transaction_journal_id ?? split?.id ?? `${entry.id}:${idx}`;
                        items.push({
                            journalId: entry.id,
                            id: splitId,
                            date: split?.date ?? entry?.attributes?.date ?? null,
                            type: split?.type ?? entry?.attributes?.transaction_type ?? null,
                            description: split?.description ?? entry?.attributes?.description ?? null,
                            amount: split?.amount ?? null,
                            currency: split?.currency_code ?? entry?.attributes?.currency_code ?? null,
                            source_name: split?.source_name ?? null,
                            destination_name: split?.destination_name ?? null,
                            category_name: split?.category_name ?? null,
                            category_id: split?.category_id ?? null,
                        });
                    });
                });
            }

            const links = result?.links ?? {};
            const meta = result?.meta?.pagination ?? {};
            const pagination = {
                first: links.first ?? null,
                next: links.next ?? null,
                prev: links.prev ?? null,
                last: links.last ?? null,
            };

            if (meta.current_page != null) {
                pagination.current = meta.current_page;
            }
            if (meta.per_page != null) {
                pagination.limit = meta.per_page;
            } else {
                pagination.limit = limit;
            }
            if (meta.total_pages != null) {
                pagination.pageCount = meta.total_pages;
            }

            res.json({
                items,
                pagination,
                rawLinks: links,
            });
        } catch (error) {
            console.error("Failed to fetch transactions", error);
            const status = error?.code ?? 500;
            res.status(status).send(error?.message ?? "Unable to fetch transactions");
        }
    }

    async #postClassify(req, res) {
        try {
            const transactionId = req.body?.transactionId;
            if (!transactionId) {
                res.status(400).send("transactionId is required");
                return;
            }

            const job = await this.#createClassificationJobFromTransactionId(transactionId);

            res.status(202).json({job});
        } catch (error) {
            console.error("Failed to enqueue classification job", error);
            const status = error?.code ?? 500;
            res.status(status).send(error?.message ?? "Unable to enqueue classification job");
        }
    }

    async #postClassifyBatch(req, res) {
        try {
            const transactionIdsInput = req.body?.transactionIds;
            if (!Array.isArray(transactionIdsInput) || transactionIdsInput.length === 0) {
                res.status(400).send("transactionIds must be a non-empty array");
                return;
            }

            const normalizedIds = Array.from(new Set(
                transactionIdsInput
                    .map(id => {
                        if (typeof id === "number" || typeof id === "string") {
                            const trimmed = String(id).trim();
                            return trimmed.length > 0 ? trimmed : null;
                        }
                        return null;
                    })
                    .filter(Boolean)
            ));

            if (normalizedIds.length === 0) {
                res.status(400).send("transactionIds must contain at least one valid identifier");
                return;
            }

            const jobs = [];
            const errors = [];

            for (const id of normalizedIds) {
                try {
                    const job = await this.#createClassificationJobFromTransactionId(id);
                    jobs.push(job);
                } catch (error) {
                    console.error(`Failed to enqueue classification job for transaction ${id}`, error);
                    errors.push({
                        transactionId: id,
                        status: error?.code ?? 500,
                        message: error?.message ?? "Unable to enqueue classification job"
                    });
                }
            }

            const payload = {jobs, errors};

            if (jobs.length === 0) {
                const status = errors[0]?.status ?? 500;
                res.status(status).json(payload);
                return;
            }

            if (errors.length > 0) {
                res.status(207).json(payload);
                return;
            }

            res.status(202).json(payload);
        } catch (error) {
            console.error("Failed to enqueue batch classification jobs", error);
            const status = error?.code ?? 500;
            res.status(status).send(error?.message ?? "Unable to enqueue classification jobs");
        }
    }

    async #createClassificationJobFromTransactionId(transactionId) {
        const transaction = await this.#firefly.getTransaction(transactionId);
        const transactionData = transaction?.data;
        if (!transactionData) {
            throw new HttpError(404, "Transaction not found");
        }

        const splits = transactionData?.attributes?.transactions ?? [];
        const primarySplit = this.#ensureClassifiableTransaction(splits);

        const normalizedId = transactionData.id ?? String(transactionId);

        const job = this.#jobList.createJob({
            transactionId: normalizedId,
            destinationName: primarySplit.destination_name,
            description: primarySplit.description
        });

        this.#enqueueClassificationJob({
            job,
            transactionId: normalizedId,
            transactions: splits,
            destinationName: primarySplit.destination_name,
            description: primarySplit.description
        });

        return job;
    }

    #enqueueClassificationJob({job, transactionId, transactions, destinationName, description}) {
        this.#queue.push(async () => {
            this.#jobList.setJobInProgress(job.id);

            const categories = await this.#firefly.getCategories();

            const classification = await this.#provider.classify({
                categories: Array.from(categories.keys()),
                destinationName,
                description,
                metadata: {
                    transactionId,
                },
            });

            const newData = Object.assign({}, job.data);
            newData.category = classification?.category ?? null;
            newData.prompt = classification?.prompt;
            newData.response = classification?.response;

            // Expense account classification
            let accountId;
            let accountAction;
            try {
                if (!description) {
                    throw new ExpenseAccountError("Missing transaction description for expense account matching");
                }

                const decision = await this.#expenseAccountMatcher.matchTransaction({
                    description,
                    destination_name: destinationName,
                });

                if (decision.decision === 'existing' && decision.account.id) {
                    accountId = decision.account.id;
                    console.info(`Matched to existing expense account: ${decision.account.name}`);
                    accountAction = "matched";
                } else if (decision.decision === 'create' && decision.account.name) {
                    console.info(`Planned to create new expense account: ${decision.account.name}`);
                    accountAction = "created";
                } else {
                    throw new ExpenseAccountError('Invalid expense account decision structure returned by AI');
                }

                newData.expenseAccount = {
                    name: decision.account.name,
                    description: decision.account.description || '',
                    action: accountAction,
                    decision: decision.decision,
                    source: decision.account.source || null,
                };
            } catch (e) {
                const error = e instanceof ExpenseAccountError ? e : new ExpenseAccountError(e.message, e);
                console.error("Could not categorize expense account", error);
                newData.expenseAccount = {
                    error: error.message,
                    action: 'failed',
                    errorType: error.name
                };
            }

            this.#jobList.updateJobData(job.id, newData);

            if (classification?.category && categories.has(classification.category)) {
                await this.#firefly.setCategory(transactionId, transactions, categories.get(classification.category));
            } else if (classification?.category) {
                console.warn(`Provider returned unknown category '${classification.category}'. Transaction will remain uncategorized.`);
            }

            // Create and/or set expense account in Firefly III
            if (newData.expenseAccount && newData.expenseAccount.action !== 'failed') {
                if (accountAction === "created") {
                    accountId = await this.#firefly.createAccount(newData.expenseAccount.name, 'expense', newData.expenseAccount.description);
                }
                await this.#firefly.setAccount(transactionId, transactions, accountId, 'destination');
            }

            this.#jobList.setJobFinished(job.id);
        });
    }

    #parsePositiveInt(value, fallback) {
        const parsed = Number.parseInt(value, 10);
        if (Number.isNaN(parsed) || parsed <= 0) {
            return fallback;
        }

        return parsed;
    }

    #ensureClassifiableTransaction(transactions) {
        if (!Array.isArray(transactions) || transactions.length === 0) {
            throw new HttpError(400, "Transaction has no splits to classify");
        }

        const primarySplit = transactions[0];
        if (primarySplit?.type !== "withdrawal") {
            throw new HttpError(400, "Only withdrawal transactions can be classified");
        }

        if (primarySplit?.category_id != null) {
            throw new HttpError(400, "Transaction already has a category");
        }

        if (!primarySplit?.description) {
            throw new HttpError(400, "Transaction is missing a description");
        }

        if (!primarySplit?.destination_name) {
            throw new HttpError(400, "Transaction is missing a destination name");
        }

        return primarySplit;
    }

}

class WebhookException extends Error {

    constructor(message) {
        super(message);
    }
}

class HttpError extends Error {
    code;

    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

class ExpenseAccountError extends Error {
    constructor(message, originalError = null) {
        super(message);
        this.name = 'ExpenseAccountError';
        this.originalError = originalError;
    }
}
