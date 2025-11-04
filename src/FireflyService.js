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
            console.error(`[Firefly] Create account error (${response.status}): ${responseText.substring(0, 200)}`);
            throw new FireflyException(response.status, response, responseText);
        }

        let data;
        const responseText = await response.text();

        try {
            console.debug(`[Firefly] Parsing create account response...`);
            data = JSON.parse(responseText);
            console.debug(`[Firefly] Successfully parsed create account response`);
        } catch (parseError) {
            console.error(`[Firefly] ERROR: Failed to parse create account response:`, responseText.substring(0, 200));
            throw new SyntaxError(`Invalid JSON from create account API: ${parseError.message}`);
        }

        return data.data.id;
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
