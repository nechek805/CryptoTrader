import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.tools/**',
      '**/dist/**',
      '**/.next/**',
      'coverage/**',
      'apps/web/next-env.d.ts',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.ts', '**/*.tsx'],
  })),
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: { '@typescript-eslint/consistent-type-imports': 'error' },
  },
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    languageOptions: {
      parserOptions: { project: './apps/web/tsconfig.json', tsconfigRootDir: import.meta.dirname },
    },
  },
);
