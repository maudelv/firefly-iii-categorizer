export default class TransactionValidator {
    static validateWebhookPayload(body) {
        if (body?.trigger !== "STORE_TRANSACTION") {
            throw new WebhookException("trigger is not STORE_TRANSACTION. Request will not be processed");
        }

        if (body?.response !== "TRANSACTIONS") {
            throw new WebhookException("trigger is not TRANSACTION. Request will not be processed");
        }

        if (!body?.content?.id) {
            throw new WebhookException("Missing content.id");
        }

        if (body?.content?.transactions?.length === 0) {
            throw new WebhookException("No transactions are available in content.transactions");
        }

        const primarySplit = body.content.transactions[0];
        this.validateClassifiableTransaction(primarySplit);

        return {
            transactionId: body.content.id,
            transactions: body.content.transactions,
            destinationName: primarySplit.destination_name,
            description: primarySplit.description
        };
    }

    static validateClassifiableTransaction(transaction) {
        if (transaction?.type !== "withdrawal") {
            throw new WebhookException("Transaction type must be 'withdrawal'");
        }

        if (transaction?.category_id !== null) {
            throw new WebhookException("Transaction already has a category");
        }

        if (!transaction?.description) {
            throw new WebhookException("Missing transaction description");
        }

        if (!transaction?.destination_name) {
            throw new WebhookException("Missing transaction destination_name");
        }
    }

    static validateTransactionSplits(splits) {
        if (!Array.isArray(splits) || splits.length === 0) {
            throw new ValidationError(400, "Transaction has no splits to classify");
        }

        const primarySplit = splits[0];
        if (primarySplit?.type !== "withdrawal") {
            throw new ValidationError(400, "Only withdrawal transactions can be classified");
        }

        if (primarySplit?.category_id != null) {
            throw new ValidationError(400, "Transaction already has a category");
        }

        if (!primarySplit?.description) {
            throw new ValidationError(400, "Transaction is missing a description");
        }

        if (!primarySplit?.destination_name) {
            throw new ValidationError(400, "Transaction is missing a destination name");
        }

        return primarySplit;
    }
}

export class WebhookException extends Error {
    constructor(message) {
        super(message);
        this.name = 'WebhookException';
    }
}

export class ValidationError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ValidationError';
        this.code = code;
    }
}
