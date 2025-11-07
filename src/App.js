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
            try {
                console.log(`[JobQueue] Starting job ${job?.id} for transaction ${transactionId}`);
                console.log(`[JobQueue] Job input data:`, {
                    transactionId,
                    destinationName,
                    description,
                    hasTransactions: !!transactions,
                    transactionsCount: transactions?.length || 0
                });

                this.#jobList.setJobInProgress(job.id);
                console.log(`[JobQueue] Job ${job?.id} marked as in progress`);

                console.log(`[JobQueue] Fetching categories from Firefly...`);
                const categories = await this.#firefly.getCategories();
                console.log(`[JobQueue] Retrieved ${categories?.size || 0} categories`);

                console.log(`[JobQueue] Starting classification with provider...`);
                const classification = await this.#provider.classify({
                    categories: Array.from(categories.keys()),
                    destinationName,
                    description,
                    metadata: {
                        transactionId,
                    },
                });
                console.log(`[JobQueue] Classification completed:`, {
                    category: classification?.category,
                    hasPrompt: !!classification?.prompt,
                    hasResponse: !!classification?.response
                });

                const newData = Object.assign({}, job.data);
                newData.category = classification?.category ?? null;
                newData.prompt = classification?.prompt;
                newData.response = classification?.response;
                console.log(`[JobQueue] Job data updated with classification results`);

                let accountAction;
                let decision;
                try {
                    console.log(`[JobQueue] Starting expense account matching...`);
                    if (!description) {
                        console.log(`[JobQueue] Missing description for expense account matching`);
                        throw new ExpenseAccountError("Missing transaction description for expense account matching");
                    }

                    console.log(`[JobQueue] Calling expense account matcher with:`, { description, destination_name: destinationName });
                    decision = await this.#expenseAccountMatcher.matchTransaction({
                        description,
                        destination_name: destinationName,
                    });
                    console.log(`[JobQueue] Account matcher decision:`, {
                        decision: decision?.decision,
                        accountName: decision?.account?.name,
                        accountId: decision?.account?.id
                    });

                    switch (decision.decision) {
                      case 'existing':
                        accountAction = "matched";
                        console.log(`[JobQueue] Account action set to: matched`);
                        break;
                      case 'create':
                        accountAction = "created";
                        console.log(`[JobQueue] Account action set to: created`);
                        break;
                      default:
                        console.log(`[JobQueue] Invalid decision structure:`, decision);
                        throw new ExpenseAccountError('Invalid expense account decision structure returned by AI');
                    }

                    newData.expenseAccount = {
                        name: decision.account.name,
                        description: decision.account.description || '',
                        action: accountAction,
                        decision: decision.decision,
                        source: decision.account.source || null,
                        accountId: decision.account?.id || null,
                    };
                    console.log(`[JobQueue] Expense account data prepared:`, {
                        name: newData.expenseAccount.name,
                        action: newData.expenseAccount.action,
                        accountId: newData.expenseAccount.accountId
                    });
                } catch (e) {
                    console.log(`[JobQueue] Error in expense account matching:`, {
                        error: e.message,
                        stack: e.stack,
                        errorType: e.constructor.name
                    });

                    const error = e instanceof ExpenseAccountError ? e : new ExpenseAccountError(e.message, e);
                    newData.expenseAccount = {
                        error: error.message,
                        action: 'failed',
                        errorType: error.name
                    };

                    console.log(`[JobQueue] Throwing CategoryError for expense account failure`);
                    throw new CategoryError(`Failed to categorize expense account: ${error.message}`);
                }

                console.log(`[JobQueue] Updating job data in JobList...`);
                this.#jobList.updateJobData(job.id, newData);
                console.log(`[JobQueue] Job data updated successfully`);

                // Category processing
                if (classification?.category && categories.has(classification.category)) {
                    console.log(`[JobQueue] Setting category '${classification.category}' for transaction ${transactionId}`);
                    await this.#firefly.setCategory(transactionId, transactions, categories.get(classification.category));
                    console.log(`[JobQueue] Category set successfully`);
                } else if (classification?.category) {
                    console.warn(`Provider returned unknown category '${classification.category}'. Transaction will remain uncategorized.`);
                } else {
                    console.log(`[JobQueue] No category to set for transaction`);
                }

                // Account processing
                if (newData.expenseAccount && newData.expenseAccount.action !== 'failed') {
                    console.log(`[JobQueue] Processing expense account action: ${newData.expenseAccount.action}`);
                    // Get current account ID from the transaction's destination account
                    // Fetch transaction data to get the primary split (without category validation)
                    const currentTransaction = await this.#firefly.getTransaction(transactionId);
                    const currentSplits = currentTransaction?.data?.attributes?.transactions ?? [];
                    const primarySplit = currentSplits[0]; // Get first split without validation
                    let resolvedAccountId = primarySplit?.destination_id || null;

                    if (accountAction === "created") {
                        console.log(`[JobQueue] Creating new expense account:`, {
                            name: newData.expenseAccount.name,
                            description: newData.expenseAccount.description
                        });
                        try {
                            resolvedAccountId = await this.#firefly.createAccount(
                                newData.expenseAccount.name,
                                'expense',
                                newData.expenseAccount.description
                            );
                            console.log(`[JobQueue] Account created successfully with ID: ${resolvedAccountId}`);
                        } catch (createError) {
                            console.error(`[JobQueue] Failed to create account:`, {
                                error: createError.message,
                                stack: createError.stack,
                                accountName: newData.expenseAccount.name
                            });

                            // Smart fallback: if account already exists, find it and use it
                            // Handle both regular and escaped Unicode characters
                            const errorMessage = createError.message;
                            const isDuplicateName =
                                errorMessage.includes('Este nombre de cuenta ya está en uso') ||
                                errorMessage.includes('Este nombre de cuenta ya est\\u00e1 en uso') ||
                                errorMessage.includes('account name already in use') ||
                                errorMessage.includes('name already in use') ||
                                errorMessage.includes('duplicate') ||
                                (errorMessage.includes('422') && errorMessage.includes('name'));

                            if (isDuplicateName) {
                                console.log(`[JobQueue] Account already exists, searching for existing account: ${newData.expenseAccount.name}`);
                                try {
                                    const suggestions = await this.#firefly.getExpenseAccountSuggestions(newData.expenseAccount.name, 50);
                                    const existingAccount = suggestions.find(suggestion => suggestion.name.toLowerCase() === newData.expenseAccount.name.toLowerCase());
                                    if (existingAccount) {
                                        resolvedAccountId = existingAccount.id;
                                        console.log(`[JobQueue] Found existing account with ID: ${resolvedAccountId}`);
                                    } else {
                                        throw new Error(`Account '${newData.expenseAccount.name}' appears to exist but could not be found`);
                                    }
                                } catch (findError) {
                                    console.error(`[JobQueue] Failed to find existing account:`, findError.message);
                                    throw findError;
                                }
                            } else {
                                throw createError; // Re-throw original error if not duplicate name
                            }
                        }
                    } else if (accountAction === "matched") {
                        resolvedAccountId = decision.account.id;
                        console.log(`[JobQueue] Using existing account ID: ${resolvedAccountId}`);
                    }

                    if (resolvedAccountId) {
                        console.log(`[JobQueue] Setting account ${resolvedAccountId} as destination for transaction ${transactionId}`);
                        await this.#firefly.setAccount(transactionId, transactions, resolvedAccountId, 'destination');
                        console.log(`[JobQueue] Account set successfully`);
                    } else {
                        const errorMsg = `[App] No accountId available to set for transaction ${transactionId}, action: ${accountAction}`;
                        console.error(`[JobQueue] ${errorMsg}`, {
                            accountAction,
                            resolvedAccountId,
                            decision,
                            newData
                        });
                        throw new Error(errorMsg);
                    }
                } else {
                    console.log(`[JobQueue] Skipping account processing:`, {
                        hasExpenseAccount: !!newData.expenseAccount,
                        action: newData.expenseAccount?.action
                    });
                }

                console.log(`[JobQueue] Marking job ${job?.id} as finished`);
                this.#jobList.setJobFinished(job.id);
                console.log(`[JobQueue] Job ${job?.id} completed successfully`);

            } catch (error) {
                console.error(`[JobQueue] CRITICAL ERROR in job ${job?.id}:`, {
                    error: error.message,
                    stack: error.stack,
                    errorType: error.constructor.name,
                    job: {
                        id: job?.id,
                        transactionId,
                        destinationName,
                        description
                    },
                    timestamp: new Date().toISOString()
                });

                // Re-lanzar el error para que la cola lo maneje
                throw error;
            }
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
