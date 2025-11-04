const DEFAULT_AUTOCOMPLETE_LIMIT = 15;
const PLACEHOLDER_VALUES = new Set([
    "",
    "no name",
    "sin nombre",
    "unknown",
    "desconocido",
]);

export default class ExpenseAccountMatcher {
    #provider;
    #firefly;
    #autocompleteLimit;
    #decisionCache;

    constructor(provider, fireflyService, options = {}) {
        if (!provider) {
            throw new Error("ExpenseAccountMatcher requires an AI provider instance");
        }

        this.#provider = provider;
        this.#firefly = fireflyService;
        this.#autocompleteLimit = options.autocompleteLimit ?? DEFAULT_AUTOCOMPLETE_LIMIT;
        this.#decisionCache = new Map();
    }

    #isPlaceholder(text) {
        if (text == null) {
            return true;
        }

        const normalized = String(text)
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .trim();

        if (normalized.length === 0) {
            return true;
        }

        const stripped = normalized
            .replace(/[()\[\]{}]/g, "")
            .replace(/"/g, "")
            .replace(/'+/g, "")
            .replace(/\s+/g, " ")
            .trim();

        return stripped.length === 0 || PLACEHOLDER_VALUES.has(stripped);
    }

    #isValidResponse(data) {
        return Boolean(
            data &&
            typeof data === "object" &&
            typeof data.decision === "string" &&
            ["existing", "create"].includes(data.decision) &&
            data.account &&
            typeof data.account === "object" &&
            typeof data.account.name === "string" &&
            data.account.name.trim().length > 0 &&
            (data.decision === "existing" || typeof data.account.description === "string")
        );
    }

    #parseResponse(responseText) {
        console.debug(`[ExpenseAccountMatcher] Attempting to parse response: "${responseText}"`);

        if (!responseText || typeof responseText !== "string") {
            console.error("[ExpenseAccountMatcher] Invalid response type or empty response");
            throw new Error("Empty or invalid response from AI");
        }

        const trimmed = responseText.trim();

        let cleaned = trimmed;
        if (cleaned.startsWith("```json")) {
            cleaned = cleaned.replace(/```json\s*/, "").replace(/```\s*$/, "");
        } else if (cleaned.startsWith("```")) {
            cleaned = cleaned.replace(/```\s*/, "").replace(/```\s*$/, "");
        }

        let jsonStr = cleaned;
        const firstBrace = cleaned.indexOf("{");
        const lastBrace = cleaned.lastIndexOf("}");

        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            jsonStr = cleaned.substring(firstBrace, lastBrace + 1);
            console.debug(`[ExpenseAccountMatcher] Extracted JSON: "${jsonStr}"`);
        }

        if (!jsonStr || jsonStr.trim().length === 0) {
            console.error("[ExpenseAccountMatcher] No JSON found in AI response");
            throw new Error("No JSON found in AI response");
        }

        try {
            const parsed = JSON.parse(jsonStr);
            console.debug("[ExpenseAccountMatcher] Successfully parsed JSON");

            if (!this.#isValidResponse(parsed)) {
                console.error("[ExpenseAccountMatcher] Invalid AI response structure:", JSON.stringify(parsed, null, 2));
                throw new Error("Invalid response structure from AI");
            }

            return parsed;
        } catch (error) {
            console.error("[ExpenseAccountMatcher] Failed to parse AI response:", responseText);
            console.error("[ExpenseAccountMatcher] Parse error:", error.message);
            throw new Error(`Failed to parse AI response: ${error.message}`);
        }
    }

    #buildPrompt(transaction, candidateNames) {
        const candidateDirective = candidateNames.length > 0 ? "existing\" or \"create" : "create";
        const candidatesText = candidateNames.length > 0 ? candidateNames.join(", ") : "None";

        return `Analyze this transaction and respond with JSON:
Transaction: "${transaction.description}"${transaction.destination_name ? ` at ${transaction.destination_name}` : ""}
Candidates: ${candidatesText}
If candidates exist, match one. Otherwise, create a new account.
Required response format:
{
    "decision": "${candidateDirective}",
    "account": {
        "name": "account name here",
        "description": "brief description here"
    }
}
No explanations, just JSON.`;
    }

    async matchTransaction(transaction) {
        if (!transaction || !transaction.description) {
            throw new Error("Transaction with description is required");
        }

        const descriptionInfo = this.#normalizeText(transaction.description);
        const destinationInfo = this.#normalizeText(transaction.destination_name ?? "");
        const cacheKey = this.#buildCacheKey(descriptionInfo.normalizedText, destinationInfo.normalizedText);

        if (this.#decisionCache.has(cacheKey)) {
            return this.#cloneDecision(this.#decisionCache.get(cacheKey));
        }

        const queries = this.#generateQueries(transaction, descriptionInfo, destinationInfo);
        const autocompleteCandidates = await this.#collectAutocompleteCandidates(queries);

        const deterministicMatch = this.#attemptDeterministicMatch(
            autocompleteCandidates,
            descriptionInfo.tokens,
            destinationInfo.tokens
        );

        if (deterministicMatch) {
            const decision = {
                decision: "existing",
                account: {
                    id: deterministicMatch.id,
                    name: deterministicMatch.name,
                    description: deterministicMatch.description ?? "",
                    source: "autocomplete",
                },
            };

            this.#decisionCache.set(cacheKey, this.#cloneDecision(decision));
            return decision;
        }

        const aiDecision = await this.#runAiDecision(transaction, autocompleteCandidates);
        this.#decisionCache.set(cacheKey, this.#cloneDecision(aiDecision));
        return aiDecision;
    }

    async #runAiDecision(transaction, candidates) {
        const candidatesArray = Array.isArray(candidates) ? candidates : [];
        const candidateNames = candidatesArray
            .map(candidate => candidate?.name ?? "")
            .filter(name => name && !this.#isPlaceholder(name));
        const prompt = this.#buildPrompt(transaction, candidateNames);

        const modelOptions = {
            temperature: 0.2,
            maxOutputTokens: 2048,
        };

        console.debug(`[ExpenseAccountMatcher] Sending prompt to AI: ${prompt}`);
        const response = await this.#provider.getCompletion(prompt, modelOptions);
        console.debug(`[ExpenseAccountMatcher] AI response: ${response}`);

        const parsedResponse = this.#parseResponse(response);
        console.debug("[ExpenseAccountMatcher] Parsed response:", JSON.stringify(parsedResponse, null, 2));

        if (parsedResponse.decision === "existing") {
            const matchingCandidate = candidatesArray.find(candidate => {
                const candidateName = candidate?.name ?? "";
                if (this.#isPlaceholder(candidateName)) {
                    return false;
                }
                return candidateName.toLowerCase() === parsedResponse.account.name.toLowerCase();
            });

            if (matchingCandidate) {
                parsedResponse.account.id = matchingCandidate.id;
            } else {
                parsedResponse.decision = "create";
            }
        }

        parsedResponse.account.description = parsedResponse.account.description ?? "";
        parsedResponse.account.source = parsedResponse.decision === "existing" ? "ai" : "ai-new";

        return parsedResponse;
    }

    #normalizeText(input) {
        if (!input || typeof input !== "string") {
            return {
                normalizedText: "",
                tokens: [],
            };
        }

        if (this.#isPlaceholder(input)) {
            return {
                normalizedText: "",
                tokens: [],
            };
        }

        const base = input
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase();

        const withoutDates = base.replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ");
        const withoutLongDigits = withoutDates.replace(/\b\d{4,}\b/g, " ");

        const genericPhrases = [
            "google pay",
            "apple pay",
            "compra en",
            "compras en",
            "con la tarjeta",
            "tarjeta",
        ];

        let simplified = withoutLongDigits;
        genericPhrases.forEach(phrase => {
            const pattern = new RegExp(`\\b${phrase.replace(/\s+/g, "\\s+")}\\b`, "g");
            simplified = simplified.replace(pattern, " ");
        });

        simplified = simplified.replace(/[^a-z\s]/g, " ");

        const stopWords = new Set([
            "con",
            "en",
            "por",
            "para",
            "una",
            "un",
            "y",
            "el",
            "la",
            "los",
            "las",
            "de",
            "del",
            "al",
            "compra",
            "compras",
            "tarjeta",
            "banco",
            "pago",
            "google",
            "pay",
            "apple",
        ]);

        const tokens = simplified
            .split(/\s+/)
            .map(token => token.trim())
            .filter(token => token.length > 1 && !stopWords.has(token) && !/^\d+$/.test(token));

        const uniqueTokens = Array.from(new Set(tokens));

        return {
            normalizedText: uniqueTokens.join(" "),
            tokens: uniqueTokens,
        };
    }

    #generateQueries(transaction, descriptionInfo, destinationInfo) {
        const queries = new Set();

        if (transaction.destination_name && !this.#isPlaceholder(transaction.destination_name)) {
            queries.add(transaction.destination_name.trim());
        }

        if (destinationInfo.normalizedText) {
            queries.add(destinationInfo.normalizedText);
        }

        if (descriptionInfo.normalizedText) {
            queries.add(descriptionInfo.normalizedText);
        }

        if (descriptionInfo.tokens.length >= 3) {
            queries.add(descriptionInfo.tokens.slice(0, 3).join(" "));
        }

        if (descriptionInfo.tokens.length >= 2) {
            queries.add(descriptionInfo.tokens.slice(0, 2).join(" "));
        }

        descriptionInfo.tokens.forEach(token => {
            if (token.length > 3) {
                queries.add(token);
            }
        });

        if (destinationInfo.tokens.length) {
            destinationInfo.tokens.forEach(token => {
                if (token.length > 3) {
                    queries.add(token);
                }
            });
        }

        return Array.from(queries)
            .map(query => query.trim())
            .filter(query => query.length > 0);
    }

    async #collectAutocompleteCandidates(queries) {
        if (!this.#firefly || !Array.isArray(queries) || queries.length === 0) {
            return [];
        }

        for (const query of queries) {
            if (this.#isPlaceholder(query)) {
                continue;
            }
            try {
                const suggestions = await this.#firefly.getExpenseAccountSuggestions(query, this.#autocompleteLimit);
                const filteredSuggestions = suggestions.filter(candidate => !this.#isPlaceholder(candidate?.name));

                if (filteredSuggestions.length > 0) {
                    console.debug(`[ExpenseAccountMatcher] Autocomplete matched '${query}' with ${filteredSuggestions.length} candidate(s)`);
                    return filteredSuggestions;
                }
            } catch (error) {
                console.error(`[ExpenseAccountMatcher] Autocomplete failed for '${query}': ${error.message}`);
            }
        }

        return [];
    }

    #attemptDeterministicMatch(candidates, descriptionTokens, destinationTokens) {
        if (!Array.isArray(candidates) || candidates.length === 0) {
            return null;
        }

        if (candidates.length === 1) {
            if (this.#isPlaceholder(candidates[0]?.name)) {
                return null;
            }
            return candidates[0];
        }

        const targetTokens = new Set([...descriptionTokens, ...destinationTokens]);
        const minimumMatches = Math.max(1, Math.ceil(targetTokens.size / 2));

        for (const candidate of candidates) {
            if (!candidate?.name) {
                continue;
            }

            const normalizedCandidate = this.#normalizeText(candidate.name);
            const candidateTokens = new Set(normalizedCandidate.tokens);

            const matches = [...targetTokens].filter(token => candidateTokens.has(token)).length;

            if (matches >= minimumMatches) {
                return candidate;
            }
        }

        return null;
    }

    #buildCacheKey(descriptionText, destinationText) {
        return `${descriptionText}::${destinationText}`;
    }

    #cloneDecision(decision) {
        return {
            decision: decision.decision,
            account: {
                id: decision.account.id,
                name: decision.account.name,
                description: decision.account.description ?? "",
                source: decision.account.source,
            },
        };
    }
}
