import {getConfigVariable} from "./util.js";

export default class FireflyService {
    #BASE_URL;
    #PERSONAL_TOKEN;

    constructor() {
        this.#BASE_URL = getConfigVariable("FIREFLY_URL")
        if (this.#BASE_URL.slice(-1) === "/") {
            this.#BASE_URL = this.#BASE_URL.substring(0, this.#BASE_URL.length - 1)
        }

        this.#PERSONAL_TOKEN = getConfigVariable("FIREFLY_PERSONAL_TOKEN")
    }

    /**
     * Fetch a page of transactions from Firefly III.
     * @param {{limit?: number, page?: number, type?: string}} [options]
     * @returns {Promise<object>}
     */
    async getTransactions({limit = 10, page = 1, type = "default"} = {}) {
        const params = new URLSearchParams({
            limit: String(limit),
            page: String(page),
            type,
        });

        const response = await fetch(`${this.#BASE_URL}/api/v1/transactions?${params.toString()}`, {
            headers: {
                Authorization: `Bearer ${this.#PERSONAL_TOKEN}`,
            }
        });

        if (!response.ok) {
            throw new FireflyException(response.status, response, await response.text());
        }

        return response.json();
    }

    /**
     * Fetch a single transaction journal by id.
     * @param {string|number} id
     * @returns {Promise<object>}
     */
    async getTransaction(id) {
        const response = await fetch(`${this.#BASE_URL}/api/v1/transactions/${id}`, {
            headers: {
                Authorization: `Bearer ${this.#PERSONAL_TOKEN}`,
            }
        });

        if (!response.ok) {
            throw new FireflyException(response.status, response, await response.text());
        }

        return response.json();
    }

    /**
     * Fetch categories on Firefly III.
     *
     * @returns {Promise<Map<string, string>>}
     */
    async getCategories() {
        const response = await fetch(`${this.#BASE_URL}/api/v1/categories`, {
            headers: {
                Authorization: `Bearer ${this.#PERSONAL_TOKEN}`,
            }
        });

        if (!response.ok) {
            throw new FireflyException(response.status, response, await response.text())
        }

        const data = await response.json();

        const categories = new Map();
        data.data.forEach(category => {
            categories.set(category.attributes.name, category.id);
        });

        return categories;
    }

    /**
     * Update transaction journals within a transaction by setting a category and adding a tag.
     *
     * @param {string} transactionId - The parent transaction ID to update.
     * @param {Array<{transaction_journal_id: string, tags?: Array<string>}>} transactions - Array of transaction journals to update with categories.
     * @param {string} categoryId - The category ID to assign to all transaction journals.
     * @returns {Promise<void>}
     */
    async setCategory(transactionId, transactions, categoryId) {
        const tag = getConfigVariable("FIREFLY_TAG", "AI categorized");

        const body = {
            apply_rules: true,
            fire_webhooks: true,
            transactions: [],
        }

        transactions.forEach(transaction => {
            let tags = transaction.tags;
            if (!tags) {
                tags = [];
            }
            tags.push(tag);

            body.transactions.push({
                transaction_journal_id: transaction.transaction_journal_id,
                category_id: categoryId,
                tags: tags,
            });
        })

        const response = await fetch(`${this.#BASE_URL}/api/v1/transactions/${transactionId}`, {
            method: "PUT",
            headers: {
                Authorization: `Bearer ${this.#PERSONAL_TOKEN}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            throw new FireflyException(response.status, response, await response.text())
        }

        await response.json();
        console.info("Transaction updated")
    }

    /**
     * Fetch accounts of a specific type from Firefly III.
     * @param {string} type The type of accounts to fetch (e.g., 'expense').
     * @returns {Promise<Map<string, string>>} A map of account names to account IDs.
     */
    async getAccounts(type) {
        const headers = {
            Authorization: `Bearer ${this.#PERSONAL_TOKEN}`
        };

        let nextUrl = `${this.#BASE_URL}/api/v1/accounts?type=${type}`;
        const accounts = new Map();

        while (nextUrl) {
            const response = await fetch(nextUrl, {headers});

            if (!response.ok) {
                throw new FireflyException(response.status, response, await response.text());
            }

            const data = await response.json();

            data.data.forEach(account => {
                accounts.set(account.attributes.name, account.id);
            });

            const nextLink = data.links?.next;
            if (!nextLink) {
                nextUrl = null;
                continue;
            }

            nextUrl = nextLink.startsWith("http")
                ? nextLink
                : `${this.#BASE_URL}${nextLink}`;
        }

        return accounts;
    }

    /**
     * Create a new account in Firefly III.
     * @param {string} name The name of the new account.
     * @param {string} type The type of the new account (e.g., 'expense').
     * @param {string} note The note for the new account, it should be an short description of the company name, you should look in internet for the company's description.
     * @returns {Promise<string>} The ID of the newly created account.
     */
    async createAccount(name, type, note = '') {
        const body = {
            name: name,
            type: type,
            note: note || '',
            iban: null,
            bic: null,
            account_number: null,
            virtual_balance: 0,
            active: true,
            order: 0,
            include_net_worth: true,
        };

        console.debug(`[Firefly] Creating account: ${name}, type: ${type}`);
        const response = await fetch(`${this.#BASE_URL}/api/v1/accounts`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.#PERSONAL_TOKEN}`,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            body: JSON.stringify(body)
        });

        console.debug(`[Firefly] Create account response status: ${response.status} ${response.statusText}`);

        if (!response.ok) {
            const responseText = await response.text();
            throw new FireflyException(response.status, response, responseText);
        }

        let data = await response.json();

        return data.data.id;
    }

    /**
     * Get expense account suggestions using the autocomplete API.
     * @param {string} query The search query based on transaction description/destination.
     * @param {number} limit The maximum number of results to return (default: 15).
     * @returns {Promise<Array<{name: string, id: string}>>} Array of account suggestions with name and id.
     */
    async getExpenseAccountSuggestions(query, limit = 15) {
        const params = new URLSearchParams({
            types: 'expense',
            query: query.trim(),
            limit: String(limit)
        });

        const url = `${this.#BASE_URL}/api/v1/autocomplete/accounts?${params.toString()}`;

        const response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${this.#PERSONAL_TOKEN}`,
            }
        });

        if (!response.ok) {
            const responseText = await response.text();
            throw new FireflyException(response.status, response, responseText);
        }

        const payload = await response.json();

        console.debug(`[ExpenseAccountSuggestions] Processing ${payload.length} account suggestions`);

        const mapped = payload
            .map(account => ({
                name: account?.name?.trim() ?? "",
                id: account?.id != null ? String(account.id) : null,
            }))
            .filter(item => item.name.length > 0 && item.id);

        return mapped;
    }

    /**
     * Set the source or destination account for a transaction.
     * @param {string} transactionId The ID of the transaction journal.
     * @param {Array<object>} transactions The transactions within the journal.
     * @param {string} accountId The ID of the account to set.
     * @param {string} accountType The type of account to set ('source' or 'destination').
     */
    async setAccount(transactionId, transactions, accountId, accountType) {
        const body = {
            apply_rules: true,
            fire_webhooks: true,
            transactions: [],
        };

        transactions.forEach(transaction => {
            const updatedTransaction = {
                transaction_journal_id: transaction.transaction_journal_id,
            };

            if (accountType === 'source') {
                updatedTransaction.source_id = accountId;
            } else {
                updatedTransaction.destination_id = accountId;
            }

            body.transactions.push(updatedTransaction);
        });

        const response = await fetch(`${this.#BASE_URL}/api/v1/transactions/${transactionId}`, {
            method: "PUT",
            headers: {
                Authorization: `Bearer ${this.#PERSONAL_TOKEN}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            throw new FireflyException(response.status, response, await response.text());
        }

        await response.json();
        console.info("Transaction account updated");
    }
}

class FireflyException extends Error {
    code;
    response;
    body;

    constructor(statusCode, response, body) {
        super(`Error while communicating with Firefly III: ${statusCode} - ${body}`);

        this.code = statusCode;
        this.response = response;
        this.body = body;
    }
}
