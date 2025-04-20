/* polyfill.ts  – hide host env‑vars from untrusted code */
import process from 'node:process'

Object.defineProperty(process, 'env', {
  get() {
    return {} as NodeJS.ProcessEnv
  },
})
