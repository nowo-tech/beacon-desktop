import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'playwright-report/', 'test-results/', 'src-tauri/target/', 'src-tauri/gen/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "MemberExpression[property.name='innerHTML']", message: 'Use text nodes (no innerHTML).' },
        { selector: "CallExpression[callee.name='eval']", message: 'No eval.' },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
