export default class Provider {
    // Subclasses should override to call their underlying inference service.
    async classify({categories, destinationName, description, metadata = {}}) { // eslint-disable-line no-unused-vars
        throw new Error(`${this.constructor.name}.classify must be implemented`);
    }

    // Expose a lightweight capability descriptor for diagnostics and UI.
    getCapabilities() {
        return {
            id: this.constructor.name.toLowerCase(),
            label: this.constructor.name,
        };
    }
}
