// Example: kv_bindings.js (or integrate into your Edge Function handler)
// Ensure @vercel/kv or @netlify/blobs is installed in your project dependencies (package.json)
// Ensures fallback for local development when neither Vercel KV nor Netlify Blobs are available

// Expose the localStorageMap for debugging
let localStorageMap = new Map(); // Local in-memory fallback
let kv; // Lazy load KV
let isNetlifyBlobs = false; // Flag to track if we're using Netlify Blobs

// Environment variable cache to avoid repeated lookups
let envCache = new Map();

// Function to read environment variables from various runtimes
// This is needed because std::env::var doesn't work in WebAssembly
function getenv(name, defaultValue = "") {
    // Check cache first
    if (envCache.has(name)) {
        return envCache.get(name);
    }

    let value = defaultValue;

    try {
        // Check for Node.js process.env
        if (typeof process !== 'undefined' && process.env) {
            if (name in process.env) {
                value = process.env[name];
            }
        }
        // Check for browser environment
        else if (typeof window !== 'undefined') {
            // Try for environment variables set via window.__ENV__ (common pattern)
            if (window.__ENV__ && name in window.__ENV__) {
                value = window.__ENV__[name];
            }
        }
        // Cloudflare Workers and other edge runtimes might have their own way
        // For example, Cloudflare Workers use env bindings set during deployment
    } catch (error) {
        console.warn(`Error reading environment variable ${name}:`, error);
    }

    // Cache the result
    envCache.set(name, value);
    return value;
}

async function getKv() {
    if (!kv) {
        try {
            // Check for Vercel KV environment
            if (typeof process !== 'undefined' &&
                process.env.KV_REST_API_URL &&
                process.env.KV_REST_API_TOKEN) {
                // Dynamic import for environments where top-level await might not be supported
                const vercelKv = require('@vercel/kv');
                kv = vercelKv.kv;
                console.log("Using Vercel KV for storage");
            }
            // Check for Netlify Blobs environment
            else if (typeof process !== 'undefined' && process.env.NETLIFY === 'true') {
                try {
                    const { getStore } = require('@netlify/blobs');
                    const store = getStore('subconverter-data');
                    isNetlifyBlobs = true;

                    // Create adapter to match Vercel KV interface
                    kv = {
                        // Get a value by key
                        get: async (key) => {
                            try {
                                const value = await store.get(key, { type: 'arrayBuffer' });
                                return value ? new Uint8Array(value) : null;
                            } catch (error) {
                                // Key not found returns null to match Vercel KV behavior
                                if (error.message.includes('not found')) {
                                    return null;
                                }
                                throw error;
                            }
                        },
                        // Set a key-value pair
                        set: async (key, value) => {
                            await store.set(key, value);
                            return "OK";
                        },
                        // Check if a key exists - Netlify doesn't have direct exists method
                        exists: async (key) => {
                            try {
                                // Try to get metadata only (more efficient than getting actual data)
                                const metadata = await store.getMetadata(key);
                                return metadata ? 1 : 0;
                            } catch (error) {
                                return 0;
                            }
                        },
                        // Scan keys with pattern matching
                        scan: async (cursor, options = {}) => {
                            const { match = "*", count = 10 } = options;

                            // List all blobs (Netlify doesn't support cursor-based pagination natively)
                            // We'll implement cursor pagination on top of the list method
                            let allKeys;

                            // If we haven't started scanning yet (cursor = 0), get all keys
                            if (cursor === 0 || cursor === '0') {
                                // If matching starts with a prefix and ends with wildcard, use prefix directly
                                const prefix = match.endsWith('*') ? match.slice(0, -1) : '';
                                const list = await store.list({ prefix });
                                allKeys = list.blobs.map(blob => blob.key);

                                // If we're using an actual regex pattern (not just prefix*), filter the results
                                if (match !== "*" && !match.match(/^[^*]+\*$/)) {
                                    // Convert glob pattern to regex (simplistic approach)
                                    const pattern = match.replace(/\*/g, ".*");
                                    const regex = new RegExp(`^${pattern}$`);
                                    allKeys = allKeys.filter(key => regex.test(key));
                                }

                                // Store the full key list in localStorageMap with a special key
                                // This lets us retrieve it on subsequent scan calls
                                const scanId = `__scan_${Date.now()}`;
                                localStorageMap.set(scanId, allKeys);

                                // Return first batch and cursor
                                const batch = allKeys.slice(0, count);
                                const nextCursor = allKeys.length > count ? `${scanId}:${count}` : '0';
                                return [nextCursor, batch];
                            } else {
                                // Parse the cursor to get scan ID and position
                                const [scanId, position] = cursor.split(':');
                                allKeys = localStorageMap.get(scanId) || [];
                                const startIndex = parseInt(position);
                                const endIndex = Math.min(startIndex + count, allKeys.length);
                                const batch = allKeys.slice(startIndex, endIndex);

                                // Return next cursor or '0' if we're done
                                const nextCursor = endIndex < allKeys.length ? `${scanId}:${endIndex}` : '0';

                                // Clean up if we're done
                                if (nextCursor === '0') {
                                    localStorageMap.delete(scanId);
                                }

                                return [nextCursor, batch];
                            }
                        },
                        // Store reference for direct access to the Netlify Blobs store
                        _store: store,
                        // Delete a key
                        del: async (key) => {
                            try {
                                await store.delete(key);
                                return 1;
                            } catch (error) {
                                console.error(`Error deleting key ${key}:`, error);
                                return 0;
                            }
                        }
                    };
                    console.log("Using Netlify Blobs for storage");
                } catch (error) {
                    console.warn("Error initializing Netlify Blobs:", error);
                    throw error; // Let the fallback handle it
                }
            } else {
                // Use local storage fallback
                console.log("No KV storage environment detected, using in-memory fallback");
                // Create an in-memory implementation that mimics the Vercel KV API
                kv = {
                    // Get a value by key
                    get: async (key) => {
                        return localStorageMap.get(key) || null;
                    },
                    // Set a key-value pair
                    set: async (key, value) => {
                        localStorageMap.set(key, value);
                        return "OK";
                    },
                    // Check if a key exists
                    exists: async (key) => {
                        return localStorageMap.has(key) ? 1 : 0;
                    },
                    // Scan keys with pattern matching
                    scan: async (cursor, options = {}) => {
                        const { match = "*", count = 10 } = options;

                        // Convert glob pattern to regex
                        const pattern = match.replace(/\*/g, ".*");
                        const regex = new RegExp(`^${pattern}$`);

                        // Get all keys that match the pattern
                        const allKeys = [...localStorageMap.keys()];
                        const matchingKeys = allKeys.filter(key => regex.test(key));

                        // Implement cursor-based pagination
                        const startIndex = parseInt(cursor) || 0;
                        const endIndex = Math.min(startIndex + count, matchingKeys.length);
                        const keys = matchingKeys.slice(startIndex, endIndex);

                        // Return next cursor or '0' if we're done
                        const nextCursor = endIndex < matchingKeys.length ? String(endIndex) : '0';

                        return [nextCursor, keys];
                    },
                    // Delete a key
                    del: async (key) => {
                        return localStorageMap.delete(key) ? 1 : 0;
                    }
                };
            }
        } catch (error) {
            console.warn("Error initializing storage, using in-memory fallback:", error);
            // Create an in-memory implementation that mimics the Vercel KV API
            kv = {
                get: async (key) => localStorageMap.get(key) || null,
                set: async (key, value) => {
                    localStorageMap.set(key, value);
                    return "OK";
                },
                exists: async (key) => localStorageMap.has(key) ? 1 : 0,
                scan: async (cursor, options = {}) => {
                    const { match = "*", count = 10 } = options;
                    const pattern = match.replace(/\*/g, ".*");
                    const regex = new RegExp(`^${pattern}$`);
                    const allKeys = [...localStorageMap.keys()];
                    const matchingKeys = allKeys.filter(key => regex.test(key));
                    const startIndex = parseInt(cursor) || 0;
                    const endIndex = Math.min(startIndex + count, matchingKeys.length);
                    const keys = matchingKeys.slice(startIndex, endIndex);
                    const nextCursor = endIndex < matchingKeys.length ? String(endIndex) : '0';
                    return [nextCursor, keys];
                },
                del: async (key) => localStorageMap.delete(key) ? 1 : 0
            };
        }
    }
    return kv;
}

// Helper to handle potential null from kv.get
// Both Vercel KV and Netlify Blobs may store raw bytes differently
// For Vercel KV, it stores raw bytes as base64 strings when using the REST API directly
// For Netlify Blobs, we request arrayBuffer type and convert to Uint8Array
async function kv_get(key) {
    try {
        const kvClient = await getKv();
        const value = await kvClient.get(key);

        if (value instanceof ArrayBuffer) {
            return new Uint8Array(value);
        } else if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
            return value;
        }

        return value === null ? undefined : value;
    } catch (error) {
        console.error(`KV get error for ${key}:`, error);
        return undefined;
    }
}

// Both Vercel KV and Netlify Blobs can handle binary data
// We'll trust the adapter to handle Uint8Array values appropriately
async function kv_set(key, value /* Uint8Array from Rust */) {
    try {
        const kvClient = await getKv();
        await kvClient.set(key, value);
    } catch (error) {
        console.error(`KV set error for ${key}:`, error);
    }
}

async function kv_exists(key) {
    try {
        const kvClient = await getKv();
        const exists = await kvClient.exists(key);
        return exists > 0;
    } catch (error) {
        console.error(`KV exists error for ${key}:`, error);
        return false;
    }
}

async function kv_list(prefix) {
    try {
        const kvClient = await getKv();

        // If using Netlify Blobs, use its native list method with prefix support
        if (isNetlifyBlobs && kvClient._store) {
            const result = await kvClient._store.list({ prefix });
            return result.blobs.map(blob => blob.key);
        }

        // Otherwise, fall back to using scan with pattern matching
        let cursor = 0;
        const keys = [];
        let scanResult;

        do {
            // Use SCAN with MATCH to find keys with the given prefix
            scanResult = await kvClient.scan(cursor, {
                match: `${prefix}*`,
                count: 100 // Limit number of keys per scan
            });

            cursor = scanResult[0]; // Update cursor for next iteration
            const resultKeys = scanResult[1]; // Array of keys from this scan

            if (resultKeys && resultKeys.length > 0) {
                keys.push(...resultKeys);
            }
        } while (cursor !== '0'); // Continue until cursor becomes '0'

        return keys;
    } catch (error) {
        console.error(`KV list error for prefix ${prefix}:`, error);
        return [];
    }
}

async function kv_del(key) {
    try {
        const kvClient = await getKv();
        await kvClient.del(key);
    } catch (error) {
        console.error(`KV del error for ${key}:`, error);
    }
}

// Use global fetch available in Edge runtime
async function fetch_url(url) {
    try {
        const response = await fetch(url);
        return response;
    } catch (error) {
        console.error(`Fetch error for ${url}:`, error);
        throw error;
    }
}

// Helper to get status from Response
async function response_status(response /* Response object */) {
    // Add type check for robustness
    if (!(response instanceof Response)) {
        throw new Error("Input is not a Response object");
    }
    return response.status;
}

// Helper to get body as bytes (Uint8Array) from Response
async function response_bytes(response /* Response object */) {
    // Add type check for robustness
    if (!(response instanceof Response)) {
        throw new Error("Input is not a Response object");
    }
    try {
        const buffer = await response.arrayBuffer();
        return new Uint8Array(buffer);
    } catch (error) {
        console.error(`Error reading response body:`, error);
        throw error;
    }
}

// WASM-compatible fetch function that works in Node.js environment
async function wasm_fetch_with_request(url, options) {
    try {
        // In Node.js environment, use node-fetch or global fetch
        // This mimics the browser's fetch API for WASM
        let headers = {};

        // Extract headers from options if present
        if (options && options.headers) {
            const headerEntries = Object.entries(options.headers);
            for (const [key, value] of headerEntries) {
                headers[key] = value;
            }
        }

        // Use the method from options or default to GET
        const method = options && options.method ? options.method : 'GET';

        // Use either global fetch (Node.js 18+) or require node-fetch
        let fetchFunc = fetch;
        if (typeof fetch === 'undefined') {
            try {
                const nodeFetch = require('node-fetch');
                fetchFunc = nodeFetch;
            } catch (e) {
                console.error('Neither global fetch nor node-fetch is available:', e);
                throw new Error('No fetch implementation available');
            }
        }

        const response = await fetchFunc(url, {
            method,
            headers,
            // Add other options as needed
        });

        return response;
    } catch (error) {
        console.error(`WASM fetch error for ${url}:`, error);
        throw error;
    }
}

// Helper to get headers from Response as an object
async function response_headers(response) {
    if (!(response instanceof Response)) {
        throw new Error("Input is not a Response object");
    }

    const headers = {};
    for (const [key, value] of response.headers.entries()) {
        headers[key] = value;
    }

    return headers;
}

// Helper to get text from Response
async function response_text(response) {
    if (!(response instanceof Response)) {
        throw new Error("Input is not a Response object");
    }

    return await response.text();
}

function dummy() {
    return "dummy";
}

// Export all functions using CommonJS syntax
module.exports = {
    localStorageMap,
    getKv,
    kv_get,
    kv_set,
    kv_exists,
    kv_list,
    kv_del,
    fetch_url,
    response_status,
    response_bytes,
    wasm_fetch_with_request,
    response_headers,
    response_text,
    getenv,
    dummy
}; 