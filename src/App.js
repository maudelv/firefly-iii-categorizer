import express from "express";
import {getConfigVariable} from "./util.js";
import FireflyService from "./FireflyService.js";
import {createProviderFromConfig} from "./providers/registry.js";
import {Server} from "socket.io";
import * as http from "http";
import Queue from "queue";
import JobList from "./JobList.js";
import ExpenseAccountMatcher from "./ExpenseAccountMatcher.js";
import TransactionValidator, {WebhookException, ValidationError} from "./TransactionValidator.js";

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
            this.#handleWebhook(req);
            res.send("Queued");
        } catch (e) {
            console.error(e)

            if (e instanceof WebhookException) {
                res.status(400).send(e.message);
            } else if (e instanceof ValidationError) {
                res.status(e.code).send(e.message);
            } else {
                res.status(500).send("Internal server error");
            }
        }
    }

    #handleWebhook(req) {
        const validated = TransactionValidator.validateWebhookPayload(req.body);

        const job = this.#jobList.createJob({
            transactionId: validated.transactionId,
            destinationName: validated.destinationName,
            description: validated.description
        });

        this.#enqueueClassificationJob({
            job,
            transactionId: validated.transactionId,
            transactions: validated.transactions,
            destinationName: validated.destinationName,
            description: validated.description
        });
    }

    async #getTransactions(req, res) {
        try {
            const limit = parseInt(req.query?.limit, 10) || 10;
            const page = parseInt(req.query?.page, 10) || 1;
            const type = typeof req.query?.type === "string" && req.query.type.trim().length > 0 ? req.query.type : "default";

            const result = await this.#firefly.getTransactions({limit, page, type});

            const items = [];
            if (Array.isArray(result?.data)) {
                result.data.forEach(entry => {
                    const transaction = entry?.attributes?.transactions?.[0];
                    if (transaction) {
                        items.push({
                            id: entry.id,
                            journalId: transaction.transaction_journal_id,
                            date: transaction.date,
                            type: transaction.type,
                            description: transaction.description,
                            amount: transaction.amount,
                            currency: transaction.currency_code,
                            source_name: transaction.source_name,
                            destination_name: transaction.destination_name,
                            category_name: transaction.category_name,
                            category_id: transaction.category_id,
                        });
                    }
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

            if (error instanceof ValidationError || error instanceof HttpError) {
                res.status(error.code).send(error.message);
            } else {
                res.status(500).send("Unable to enqueue classification job");
            }
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

                    const status = (error instanceof ValidationError || error instanceof HttpError)
                        ? error.code
                        : 500;

                    errors.push({
                        transactionId: id,
                        status: status,
                        message: error.message || "Unable to enqueue classification job"
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

            if (error instanceof ValidationError || error instanceof HttpError) {
                res.status(error.code).send(error.message);
            } else {
                res.status(500).send("Unable to enqueue classification jobs");
            }
        }
    }

    async #createClassificationJobFromTransactionId(transactionId) {
        const transaction = await this.#firefly.getTransaction(transactionId);
        const transactionData = transaction?.data;
        if (!transactionData) {
            throw new HttpError(404, "Transaction not found");
        }

        const splits = transactionData?.attributes?.transactions ?? [];
        const primarySplit = TransactionValidator.validateTransactionSplits(splits);
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
            const context = new JobContext(job, transactionId, transactions, destinationName, description);

            try {
                console.info(`[Job ${job.id}] Starting classification for transaction ${transactionId}`);
                this.#jobList.setJobInProgress(job.id);

                await this.#executeClassification(context);
                await this.#executeAccountMatching(context);

                this.#jobList.updateJobData(job.id, context.jobData);

                await this.#applyClassificationResults(context);

                this.#jobList.setJobFinished(job.id);
                console.info(`[Job ${job.id}] Completed successfully`);
            } catch (error) {
                console.error(`[Job ${job.id}] Failed:`, error.message);
                throw error;
            }
        });
    }

    async #executeClassification(context) {
        const categories = await this.#firefly.getCategories();

        const classification = await this.#provider.classify({
            categories: Array.from(categories.keys()),
            destinationName: context.destinationName,
            description: context.description,
            metadata: {transactionId: context.transactionId},
        });

        context.setClassification(classification, categories);
        console.info(`[Job ${context.job.id}] Classification: ${classification?.category || 'none'}`);
    }

    async #executeAccountMatching(context) {
        try {
            const decision = await this.#expenseAccountMatcher.matchTransaction({
                description: context.description,
                destination_name: context.destinationName,
            });

            const accountAction = decision.decision === 'existing' ? 'matched' : 'created';

            context.setExpenseAccount({
                name: decision.account.name,
                description: decision.account.description || '',
                action: accountAction,
                decision: decision.decision,
                source: decision.account.source || null,
                accountId: decision.account.id || null,
            });

            console.info(`[Job ${context.job.id}] Account: ${decision.account.name} (${accountAction})`);
        } catch (error) {
            const expenseError = error instanceof ExpenseAccountError ? error : new ExpenseAccountError(error.message, error);
            context.setExpenseAccountError(expenseError);
            throw new CategoryError(`Failed to categorize expense account: ${expenseError.message}`);
        }
    }

    async #applyClassificationResults(context) {
        if (context.shouldApplyCategory()) {
            await this.#firefly.setCategory(
                context.transactionId,
                context.transactions,
                context.categoryId
            );
            console.info(`[Job ${context.job.id}] Category applied: ${context.jobData.category}`);
        } else if (context.jobData.category) {
            console.warn(`[Job ${context.job.id}] Unknown category '${context.jobData.category}', skipping`);
        }

        if (context.shouldApplyAccount()) {
            const accountId = await this.#resolveAccountId(context);
            await this.#firefly.setAccount(
                context.transactionId,
                context.transactions,
                accountId,
                'destination'
            );
            console.info(`[Job ${context.job.id}] Account applied: ${accountId}`);
        }
    }

    async #resolveAccountId(context) {
        const expenseAccount = context.jobData.expenseAccount;

        if (expenseAccount.action === 'matched') {
            return expenseAccount.accountId;
        }

        if (expenseAccount.action === 'created') {
            try {
                return await this.#firefly.createAccount(
                    expenseAccount.name,
                    'expense',
                    expenseAccount.description
                );
            } catch (createError) {
                if (this.#isDuplicateAccountError(createError)) {
                    return await this.#findExistingAccount(expenseAccount.name);
                }
                throw createError;
            }
        }

        throw new Error(`Cannot resolve account ID for action: ${expenseAccount.action}`);
    }

    #isDuplicateAccountError(error) {
        return error.message.includes('422');
    }

    async #findExistingAccount(accountName) {
        const suggestions = await this.#firefly.getExpenseAccountSuggestions(accountName, 50);
        const existingAccount = suggestions.find(
            suggestion => suggestion.name.toLowerCase() === accountName.toLowerCase()
        );

        if (!existingAccount) {
            throw new Error(`Account '${accountName}' appears to exist but could not be found`);
        }

        return existingAccount.id;
    }
}

class JobContext {
    constructor(job, transactionId, transactions, destinationName, description) {
        this.job = job;
        this.transactionId = transactionId;
        this.transactions = transactions;
        this.destinationName = destinationName;
        this.description = description;

        this.jobData = {...job.data};
        this.categories = null;
        this.categoryId = null;
    }

    setClassification(classification, categories) {
        this.categories = categories;
        this.jobData.category = classification?.category || null;
        this.jobData.prompt = classification?.prompt;
        this.jobData.response = classification?.response;

        if (classification?.category && categories.has(classification.category)) {
            this.categoryId = categories.get(classification.category);
        }
    }

    setExpenseAccount(accountData) {
        this.jobData.expenseAccount = accountData;
    }

    setExpenseAccountError(error) {
        this.jobData.expenseAccount = {
            error: error.message,
            action: 'failed',
            errorType: error.name
        };
    }

    shouldApplyCategory() {
        return this.jobData.category && this.categoryId;
    }

    shouldApplyAccount() {
        return this.jobData.expenseAccount && this.jobData.expenseAccount.action !== 'failed';
    }
}

class HttpError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'HttpError';
        this.code = code;
    }
}

class CategoryError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CategoryError'
    }
}

class ExpenseAccountError extends Error {
    constructor(message, originalError = null) {
        super(message);
        this.name = 'ExpenseAccountError';
        this.originalError = originalError;
    }
}
