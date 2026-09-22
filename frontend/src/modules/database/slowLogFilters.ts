/** 慢查询日志筛选。库表匹配看 SQL 里的 USE / db.table，和二进制日志的筛选语义对齐。 */

export interface SlowLogFilterEntry {
  time: string;
  userHost: string;
  queryTime: number;
  sql: string;
}

export interface SlowLogFilters {
  dateFrom: string;
  dateTo: string;
  minQueryTime: string;
  databases: string[];
  tables: string[];
  keyword: string;
}

export const EMPTY_SLOW_LOG_FILTERS: SlowLogFilters = {
  dateFrom: "",
  dateTo: "",
  minQueryTime: "",
  databases: [],
  tables: [],
  keyword: "",
};

interface NaiveDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function parseNaiveDateTime(value: string): NaiveDateTime | null {
  const s = value.trim();
  if (!s) return null;

  const local = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (local) {
    return {
      year: Number.parseInt(local[1], 10),
      month: Number.parseInt(local[2], 10),
      day: Number.parseInt(local[3], 10),
      hour: Number.parseInt(local[4], 10),
      minute: Number.parseInt(local[5], 10),
      second: local[6] ? Number.parseInt(local[6], 10) : 0,
    };
  }

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (iso) {
    return {
      year: Number.parseInt(iso[1], 10),
      month: Number.parseInt(iso[2], 10),
      day: Number.parseInt(iso[3], 10),
      hour: Number.parseInt(iso[4], 10),
      minute: Number.parseInt(iso[5], 10),
      second: Number.parseInt(iso[6], 10),
    };
  }

  const legacy = s.match(/^(\d{2})(\d{2})(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (legacy) {
    return {
      year: 2000 + Number.parseInt(legacy[1], 10),
      month: Number.parseInt(legacy[2], 10),
      day: Number.parseInt(legacy[3], 10),
      hour: Number.parseInt(legacy[4], 10),
      minute: Number.parseInt(legacy[5], 10),
      second: Number.parseInt(legacy[6], 10),
    };
  }

  return null;
}

function compareNaiveDateTime(a: NaiveDateTime, b: NaiveDateTime): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  if (a.day !== b.day) return a.day - b.day;
  if (a.hour !== b.hour) return a.hour - b.hour;
  if (a.minute !== b.minute) return a.minute - b.minute;
  return a.second - b.second;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** SQL 标识符两侧可选的引号：` ' " */
const SQL_QUOTE = "[`\"']?";

export function hasActiveSlowLogFilters(filters: SlowLogFilters): boolean {
  return Boolean(
    filters.dateFrom ||
      filters.dateTo ||
      filters.minQueryTime.trim() ||
      filters.databases.length > 0 ||
      filters.tables.length > 0 ||
      filters.keyword.trim(),
  );
}

/** 编译一次，避免每条日志、每次按键都重新构造正则。 */
export function compileSlowLogFilter(
  filters: SlowLogFilters,
): (entry: SlowLogFilterEntry) => boolean {
  const minSeconds = filters.minQueryTime.trim() ? Number.parseFloat(filters.minQueryTime) : Number.NaN;
  const hasMin = Number.isFinite(minSeconds);
  const from = filters.dateFrom ? parseNaiveDateTime(filters.dateFrom) : null;
  const to = filters.dateTo ? parseNaiveDateTime(filters.dateTo) : null;
  const keyword = filters.keyword.trim().toLowerCase();

  const databaseRes = filters.databases.map((name) => {
    const escaped = escapeRegExp(name);
    return new RegExp(
      `(?:\\buse\\s+${SQL_QUOTE}${escaped}${SQL_QUOTE}\\b)|(?:${SQL_QUOTE}${escaped}${SQL_QUOTE}\\s*\\.)`,
      "i",
    );
  });

  const tableRes = filters.tables.map((qualified) => {
    const dot = qualified.indexOf(".");
    const database = dot >= 0 ? qualified.slice(0, dot) : "";
    const table = dot >= 0 ? qualified.slice(dot + 1) : qualified;
    const dbEscaped = escapeRegExp(database);
    const tableEscaped = escapeRegExp(table);
    return {
      qualified: new RegExp(
        `${SQL_QUOTE}${dbEscaped}${SQL_QUOTE}\\s*\\.\\s*${SQL_QUOTE}${tableEscaped}${SQL_QUOTE}`,
        "i",
      ),
      useDb: database ? new RegExp(`\\buse\\s+${SQL_QUOTE}${dbEscaped}${SQL_QUOTE}\\b`, "i") : null,
      bare: new RegExp(
        `\\b(?:from|join|update|into|table)\\s+${SQL_QUOTE}${tableEscaped}${SQL_QUOTE}\\b`,
        "i",
      ),
    };
  });

  return (entry) => {
    if (hasMin && entry.queryTime < minSeconds) return false;

    if (from || to) {
      const timestamp = parseNaiveDateTime(entry.time);
      if (!timestamp) return false;
      if (from && compareNaiveDateTime(timestamp, from) < 0) return false;
      if (to && compareNaiveDateTime(timestamp, to) > 0) return false;
    }

    if (databaseRes.length > 0 && !databaseRes.some((re) => re.test(entry.sql))) {
      return false;
    }

    if (tableRes.length > 0) {
      const hit = tableRes.some((re) => {
        if (re.qualified.test(entry.sql)) return true;
        return Boolean(re.useDb?.test(entry.sql) && re.bare.test(entry.sql));
      });
      if (!hit) return false;
    }

    if (keyword) {
      const haystack = `${entry.sql}\n${entry.userHost}\n${entry.time}`.toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }

    return true;
  };
}
