export default class Provider {
    /**
     * Get completion from the model.
     * @param {string} prompt - The prompt to send
     * @param {object} modelOptions - Model-specific options
     * @param {number} [modelOptions.temperature] - Sampling temperature (0.0-2.0)
     * @param {number} [modelOptions.max_tokens] - Maximum number of tokens to generate
     * @returns {Promise<Object>} The completion result
     */
    async getCompletion(prompt, modelOptions = {}) { // eslint-disable-line no-unused-vars
        throw new Error(`${this.constructor.name}.getCompletion must be implemented`);
    }

    /**
     * Get classification prompt for transaction categorization.
     * @param {object} options - The classification options
     * @param {string[]} options.categories - List of categories to classify into
     * @param {string} options.destinationName - Transaction destination name
     * @param {string} options.description - Transaction description
     * @param {object} [options.metadata={}] - Additional metadata for the transaction
     * @returns {Promise<Object>} The classification prompt configuration to use
     */
    async getClassificationPrompt({categories, destinationName, description, metadata = {}}) { // eslint-disable-line no-unused-vars
        throw new Error(`${this.constructor.name}.getClassificationPrompt must be implemented`);
    }

    /**
     * Get expense account creation prompt for new account generation.
     * @param {object} options - The account creation options
     * @param {string} options.description - Transaction description
     * @param {string} [options.destinationName] - Transaction destination/merchant name
     * @param {object} [options.metadata={}] - Additional metadata for the transaction
     * @returns {Promise<Object>} The expense account creation prompt configuration to use
     */
    async getExpenseAccountCreationPrompt({description, destinationName, metadata = {}}) { // eslint-disable-line no-unused-vars
        throw new Error(`${this.constructor.name}.getExpenseAccountCreationPrompt must be implemented`);
    }

    // Expose a lightweight capability descriptor for diagnostics and UI.
    getCapabilities() {
        return {
            id: this.constructor.name.toLowerCase(),
            label: this.constructor.name,
            supportedOptions: ['temperature', 'maxTokens']
        };
    }
}
