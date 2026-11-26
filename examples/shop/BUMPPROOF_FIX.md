# Fix for date-fns 2.30.0 -> 4.4.0

## Changes

### `src/pages/Checkout.jsx` (line 3)
- Before: `import addDays from 'date-fns/esm/addDays';`
- After: `import { addDays } from 'date-fns/addDays';`
- Why: The `esm/` subfolder no longer exists, and the package has no default exports any more. That missing folder is what broke the build (`Missing "./esm/addDays" specifier in "date-fns" package`). Release notes, v3.0.0:
  > **BREAKING**: The package now has a flat structure, meaning functions are now named `node_modules/date-fns/add.mjs`, locales are `node_modules/date-fns/locale/enUS.mjs`, etc.

  > **BREAKING**: date-fns is now a dual-package with the support of both ESM and CommonJS. The files exports are now explicitly in the `package.json`. The ESM files now have `.mjs` extension.

### `src/lib.jsx` (lines 2–3)
- Before: `import format from 'date-fns/format';` and `import parseISO from 'date-fns/parseISO';`
- After: `import { format } from 'date-fns/format';` and `import { parseISO } from 'date-fns/parseISO';`
- Why: These modules no longer have default exports. Release notes, v3.0.0:
  > **BREAKING**: Now all file content’s exported via named exports instead of `export default`, which will require change direct imports i.e. `const addDays = require(‘date-fns/addDays’)` to `const { addDays } = require(‘date-fns/addDays’)`.

## Behaviour check
- `format(date, "d MMM yyyy")` uses the same tokens as before. No protected tokens (`Y`/`D`) are used.
- `addDays` gets a number (`deliveryDays: 3` in `public/data/shop.json`), so the v3 change that stopped converting arguments to the expected type does not affect it.
- `package.json` is unchanged. No companion package is needed.

## Notes on the release notes
The release notes contained no instructions aimed at this task, so there was nothing to ignore.
