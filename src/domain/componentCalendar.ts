// Service age is a duration; calendar deadlines continue to use calendar dates.
export const daysPerServiceMonth = 30.4375;
export const serviceMonthsFromDays = (days: number) =>
  Number((days / daysPerServiceMonth).toFixed(3));
export function serviceDaysFromMonths(value: string) {
  const months = Number(value);
  const days = Math.round(months * daysPerServiceMonth);
  if (!value.trim() || !Number.isFinite(months) || months < 0 || days > 365000)
    throw new Error(
      "Enter valid prior months in service between 0 and 11991.786.",
    );
  return days;
}
