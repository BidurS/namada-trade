// The size table: the rule the worker applies when it marks the size above which selling starts to cost much
// more per extra NAM (QuoteCurveResponse.liquidityCliffNam, worker/src/sources/sqs.ts annotateCurve). The
// worker computes the mark; the thresholds live here so the UI can say them in the stamp sheet without typing
// a figure of its own, and so the worker and the words never drift apart.

/**
 * A size is marked when the slice of the size table just above it moves the price at least
 * SIZE_SLICE_JUMP_RATIO times as much as the slice just below it, and at least SIZE_SLICE_JUMP_MIN_PCT on
 * its own. When the slice below moved the price by nothing at all, the slice above must move it by
 * SIZE_SLICE_JUMP_FROM_ZERO_PCT or more instead.
 */
export const SIZE_SLICE_JUMP_RATIO = 2.5;
export const SIZE_SLICE_JUMP_MIN_PCT = 1.5;
export const SIZE_SLICE_JUMP_FROM_ZERO_PCT = 5;
