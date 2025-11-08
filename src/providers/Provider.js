export default class Provider {
    /**
     * Subclasses should override to call their underlying inference service.
     * @param {object} options - The request options
     * @param {string[]} options.categories - List of categories to classify into
     * @param {string} options.destinationName - Transaction destination name
     * @param {string} options.description - Transaction description
     * @param {object} options.metadata - Additional metadata
     * @param {object} options.modelOptions - Model-specific options (temperature, maxTokens, etc.)
     */
    async classify({categories, destinationName, description, metadata = {}, modelOptions = {}}) { // eslint-disable-line no-unused-vars
        throw new Error(`${this.constructor.name}.classify must be implemented`);
    }

    /**
     * Get completion from the model.
     * @param {string} prompt - The prompt to send
     * @param {object} modelOptions - Model-specific options
     * @param {number} [modelOptions.temperature] - Sampling temperature (0.0-2.0)
     * @param {number} [modelOptions.max_tokens] - Maximum number of tokens to generate
     */
    async getCompletion(prompt, modelOptions = {}) { // eslint-disable-line no-unused-vars
        throw new Error(`${this.constructor.name}.getCompletion must be implemented`);
    }

    /**
     * Get prompt from the model.
     * @returns {string} prompt - The prompt to use
     */
    async getPrompt() { // eslint-disable-line no-unused-vars
        throw new Error(`${this.constructor.name}.getPrompt must be implemented`);
    }

    /**
     * Get expense account prompt from the model.
     * @returns {string} prompt - The prompt to use
     */
    async getExpenseAccountPrompt() { // eslint-disable-line no-unused-vars
        throw new Error(`${this.constructor.name}.getExpenseAccountPrompt must be implemented`);
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
