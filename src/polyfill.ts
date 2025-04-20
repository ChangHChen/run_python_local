import process from 'node:process'

// We don't need to stub process.env like in the Pyodide version
// because we actually want access to the local environment
// But we'll keep this file for compatibility