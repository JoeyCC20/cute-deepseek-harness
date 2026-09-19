import { clientBundle } from '../../client/tsdown.client.ts'

/**
 * Dual-face build: the node half (lib/index.js) plus the browser client bundle
 * (lib/client.js) through the shared UI-plugin preset.
 */
export default clientBundle('@deepseek-ai/dsh-pixies', ['lib/types/index.js'])
