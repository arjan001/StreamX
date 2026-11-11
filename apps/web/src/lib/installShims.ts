/**
 * Platform gaps filled in before any other module is evaluated.
 *
 * Imported FIRST by `main.tsx`, and that is the whole point of the file: ES
 * imports are hoisted and evaluated before any statement in the importing
 * module's body, so a call placed among the imports runs AFTER every one of
 * them. A module whose own evaluation does the work is the only ordering the
 * language actually guarantees.
 *
 * See `lib/randomUuid.ts` for what is missing and why.
 */
import { installRandomUuid } from './randomUuid.ts';

export const shimmedRandomUuid = installRandomUuid();
