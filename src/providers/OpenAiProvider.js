import Provider from "./Provider.js";
import OpenAiService from "../OpenAiService.js";

export default class OpenAiProvider extends Provider {
    #service;

    constructor() {
        super();
        this.#service = new OpenAiService();
    }

    async classify({categories, destinationName, description, metadata = {}, modelOptions = {}}) { // eslint-disable-line no-unused-vars
        return this.#service.classify(categories, destinationName, description, modelOptions);
    }

    async getCompletion(prompt, modelOptions = {}) {
        return this.#service.getCompletion(prompt, modelOptions);
    }

    getCapabilities() {
        return {
            id: "openai",
            label: "OpenAI",
            models: [this.#service.getModel()],
        };
    }
}
