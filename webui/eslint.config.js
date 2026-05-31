import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

const reactHooksFlat = reactHooks.configs.flat['recommended-latest']
const reactRefreshVite = reactRefresh.configs.vite

export default tseslint.config(
  { ignores: ['dist'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: {
      ...reactHooksFlat.plugins,
      ...reactRefreshVite.plugins,
    },
    rules: {
      ...reactHooksFlat.rules,
      ...reactRefreshVite.rules,
      // `_` 接頭辞の引数は意図的な未使用（no-op スタブ等）として許可する
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
)
