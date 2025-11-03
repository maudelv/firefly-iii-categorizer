import express from "express";
import {getConfigVariable} from "./util.js";
import FireflyService from "./FireflyService.js";
import {createProviderFromConfig} from "./providers/registry.js";
import {Server} from "socket.io";
import * as http from "http";
import Queue from "queue";
import JobList from "./JobList.js";

export default class App {
    #PORT;
    #ENABLE_UI;

    #firefly;
    #provider;

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

        this.#queue = new Queue({
            timeout: 30 * 1000,
            concurrency: 1,
            autostart: true
        });

        this.#queue.addEventListener('start', job => console.log('Job started', job))
        this.#queue.addEventListener('success', event => console.log('Job success', event.job))
        this.#queue.addEventListener('error', event => console.error('Job error', event.job, event.err, event))
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

            const transaction = await this.#firefly.getTransaction(transactionId);
            const transactionData = transaction?.data;
            if (!transactionData) {
                res.status(404).send("Transaction not found");
                return;
            }

            const splits = transactionData?.attributes?.transactions ?? [];
            if (!Array.isArray(splits) || splits.length === 0) {
                res.status(400).send("Transaction has no splits to classify");
                return;
            }

            const primarySplit = splits[0];
            if (primarySplit?.type !== "withdrawal") {
                res.status(400).send("Only withdrawal transactions can be classified");
                return;
            }

            if (primarySplit?.category_id != null) {
                res.status(400).send("Transaction already has a category");
                return;
            }

            if (!primarySplit?.description) {
                res.status(400).send("Transaction is missing a description");
                return;
            }

            if (!primarySplit?.destination_name) {
                res.status(400).send("Transaction is missing a destination name");
                return;
            }

            const job = this.#jobList.createJob({
                transactionId: transactionData.id ?? String(transactionId),
                destinationName: primarySplit.destination_name,
                description: primarySplit.description
            });

            this.#enqueueClassificationJob({
                job,
                transactionId: transactionData.id ?? String(transactionId),
                transactions: splits,
                destinationName: primarySplit.destination_name,
                description: primarySplit.description
            });

            res.status(202).json({job});
        } catch (error) {
            console.error("Failed to enqueue classification job", error);
            const status = error?.code ?? 500;
            res.status(status).send(error?.message ?? "Unable to enqueue classification job");
        }
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

            this.#jobList.updateJobData(job.id, newData);

            if (classification?.category && categories.has(classification.category)) {
                await this.#firefly.setCategory(transactionId, transactions, categories.get(classification.category));
            } else if (classification?.category) {
                console.warn(`Provider returned unknown category '${classification.category}'. Transaction will remain uncategorized.`);
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
}

class WebhookException extends Error {

    constructor(message) {
        super(message);
    }
}
