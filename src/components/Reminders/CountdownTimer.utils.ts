const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

export const getLocalTimezoneLabel = (): string => {
  const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date())
  return parts.find(part => part.type === 'timeZoneName')?.value || Intl.DateTimeFormat().resolvedOptions().timeZone
}

export const parseReleaseTarget = (value?: string | null): Date | null => {
  if (!value) return null

  if (DATE_ONLY_RE.test(value)) {
    const [year, month, day] = value.split('-').map(Number)
    return new Date(year, month - 1, day, 9, 0, 0, 0)
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export const formatLocalReleaseTime = (value?: string | null): string => {
  const target = parseReleaseTarget(value)
  if (!target) return 'Time not set'

  return `${target.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })} at ${target.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })} ${getLocalTimezoneLabel()}`
}

export const isFutureReleaseTarget = (value?: string | null): boolean => {
  const target = parseReleaseTarget(value)
  return !!target && target.getTime() > Date.now()
}
