// Polyfills for Node.js globals
import { Buffer } from 'buffer'
import process from 'process'

window.Buffer = Buffer
window.process = process
