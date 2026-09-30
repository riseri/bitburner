// Pure funding metadata: safe to import from resident snapshot consumers.
// A chain already includes the current purchase. Only its actionable step's
// selected donation is added; later reputation/favor states are not projected.
export function augmentationFundingCost(next) {
    const purchase = (next?.chainCost || next?.price) ?? 0;
    // Invalid quotes must remain nonfinite so they cannot authorize spending.
    return purchase + (next?.donationPlanned ? next.donationCost ?? NaN : 0);
}

export function augmentationReputationStrategy(next) {
    return next?.repGap > 0 ? next.donationPlanned ? "DONATE" : "WORK" : "NONE";
}
