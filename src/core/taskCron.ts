export const defaultTaskTimezone = "Asia/Shanghai";

type CronField = {
  values: Set<number>;
  wildcard: boolean;
};

type ParsedCron = {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
};

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

export function cronMatches(expression: string, now = new Date(), timezone = defaultTaskTimezone) {
  const parts = cronParts(expression);
  if (!parts) return false;
  return parsedCronMatches(parts, now, dateTimeFormatter(timezone));
}

function parsedCronMatches(parts: ParsedCron, now: Date, formatter: Intl.DateTimeFormat) {
  const local = localDateParts(now, formatter);
  const dayOfMonthMatches = parts.dayOfMonth.values.has(local.dayOfMonth);
  const dayOfWeekMatches = parts.dayOfWeek.values.has(local.dayOfWeek);
  const dayMatches = parts.dayOfMonth.wildcard || parts.dayOfWeek.wildcard
    ? dayOfMonthMatches && dayOfWeekMatches
    : dayOfMonthMatches || dayOfWeekMatches;
  return parts.minute.values.has(local.minute)
    && parts.hour.values.has(local.hour)
    && parts.month.values.has(local.month)
    && dayMatches;
}

export function isCronExpression(expression: string) {
  return Boolean(cronParts(expression));
}

export function cronMinuteKey(date: Date, timezone = defaultTaskTimezone) {
  const local = localDateParts(date, dateTimeFormatter(timezone));
  return `${local.year}-${local.month}-${local.dayOfMonth}-${local.hour}-${local.minute}`;
}

export function cronMinuteKeyFromIso(value: string | undefined, timezone = defaultTaskTimezone) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? cronMinuteKey(date, timezone) : null;
}

export function nextCronRun(expression: string, from = new Date(), timezone = defaultTaskTimezone) {
  const parts = cronParts(expression);
  if (!parts) return null;
  const formatter = dateTimeFormatter(timezone);
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const maxMinutes = 366 * 24 * 60;
  for (let offset = 0; offset < maxMinutes; offset += 1) {
    const candidate = new Date(start.getTime() + offset * 60_000);
    if (parsedCronMatches(parts, candidate, formatter)) return candidate;
  }
  return null;
}

function cronParts(expression: string): ParsedCron | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const parsedMinute = parseCronField(minute, 0, 59);
  const parsedHour = parseCronField(hour, 0, 23);
  const parsedDayOfMonth = parseCronField(dayOfMonth, 1, 31);
  const parsedMonth = parseCronField(month, 1, 12);
  const parsedDayOfWeek = parseCronField(dayOfWeek, 0, 7, (value) => value === 7 ? 0 : value);
  if (!parsedMinute?.values.size || !parsedHour?.values.size || !parsedDayOfMonth?.values.size || !parsedMonth?.values.size || !parsedDayOfWeek?.values.size) {
    return null;
  }
  return {
    minute: parsedMinute,
    hour: parsedHour,
    dayOfMonth: parsedDayOfMonth,
    month: parsedMonth,
    dayOfWeek: parsedDayOfWeek
  };
}

function parseCronField(field: string, min: number, max: number, normalize: (value: number) => number = (value) => value) {
  const values = new Set<number>();
  const fullValues = new Set<number>();
  for (let value = min; value <= max; value += 1) {
    fullValues.add(normalize(value));
  }
  for (const rawPart of field.split(",")) {
    const [rangePart, stepPart] = rawPart.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    const [start, end] = rangeBounds(rangePart, min, max);
    if (start == null || end == null) return null;
    for (let value = start; value <= end; value += step) {
      if (value >= min && value <= max) values.add(normalize(value));
    }
  }
  return {
    values,
    wildcard: values.size === fullValues.size && [...fullValues].every((value) => values.has(value))
  };
}

function rangeBounds(value: string, min: number, max: number): [number | null, number | null] {
  if (value === "*") return [min, max];
  if (value.includes("-")) {
    const [start, end] = value.split("-").map(Number);
    return Number.isInteger(start) && Number.isInteger(end) && start <= end ? [start, end] : [null, null];
  }
  const number = Number(value);
  return Number.isInteger(number) ? [number, number] : [null, null];
}

function dateTimeFormatter(timezone: string) {
  const cached = dateTimeFormatters.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    year: "numeric",
    weekday: "short",
    hourCycle: "h23",
    hour12: false
  });
  dateTimeFormatters.set(timezone, formatter);
  return formatter;
}

function localDateParts(date: Date, formatter: Intl.DateTimeFormat) {
  const parts = formatter.formatToParts(date);
  const getNumber = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  return {
    minute: getNumber("minute"),
    hour: getNumber("hour"),
    year: getNumber("year"),
    dayOfMonth: getNumber("day"),
    month: getNumber("month"),
    dayOfWeek: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday)
  };
}
