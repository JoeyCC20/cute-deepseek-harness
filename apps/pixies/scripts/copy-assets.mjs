/** Copy non-TypeScript runtime assets into lib/ so clean builds stay complete. */

import { copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
copyFileSync(join(root, 'src', 'pixies-keychain.cjs'), join(root, 'lib', 'pixies-keychain.cjs'))
