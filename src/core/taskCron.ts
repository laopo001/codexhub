export const defaultTaskTimezone = "Asia/Shanghai";

export function cronMatches(expression: string, now = new Date(), timezone = defaultTaskTimezone) {
  const parts = cronParts(expression);
  if (!parts) return false;
  const local = localDateParts(now, timezone);
  return parts.minute.has(local.minute)
    && parts.hour.has(local.hour)
    && parts.dayOfMonth.has(local.dayOfMonth)
    && parts.month.has(local.month)
    && parts.dayOfWeek.has(local.dayOfWeek);
}

export function isCronExpression(expression: string) {
  return Boolean(cronParts(expression));
}

export function cronMinuteKey(date: Date, timezone = defaultTaskTimezone) {
  const local = localDateParts(date, timezone);
  return `${local.year}-${local.month}-${local.dayOfMonth}-${local.hour}-${local.minute}`;
}

function cronParts(expression: string) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const parsedMinute = parseCronField(minute, 0, 59);
  const parsedHour = parseCronField(hour, 0, 23);
  const parsedDayOfMonth = parseCronField(dayOfMonth, 1, 31);
  const parsedMonth = parseCronField(month, 1, 12);
  const parsedDayOfWeek = parseCronField(dayOfWeek, 0, 7, (value) => value === 7 ? 0 : value);
  if (!parsedMinute?.size || !parsedHour?.size || !parsedDayOfMonth?.size || !parsedMonth?.size || !parsedDayOfWeek?.size) {
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
  return values;
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

function localDateParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    year: "numeric",
    weekday: "short",
    hourCycle: "h23",
    hour12: false
  }).formatToParts(date);
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
