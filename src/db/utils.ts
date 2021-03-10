import SQL, { SQLStatement } from "sql-template-strings";
import SqlString from "sqlstring";

export type Filter = { [key: string]: any | any[] };
export type Range = [number, number];
export type Sort = [string, string];
export type CustomFilter = { [key: string]: { field: string; comparison: any | any[] } };

export function sqlFixFilterSortRange(
  sql: SQLStatement,
  filters?: Filter,
  range?: Range,
  sort?: Sort,
  customFilters?: CustomFilter,
) {
  if (
    (filters && Object.entries(filters).length > 0) ||
    (customFilters && Object.entries(customFilters).length > 0)
  ) {
    sql.append("WHERE ");
  }

  if (filters && Object.entries(filters).length > 0) {
    const f = Object.entries(filters);

    for (let i = 0; i < f.length; i++) {
      sql.append(SqlString.escapeId(f[i][0]));
      const value = f[i][1];

      if (Array.isArray(value) && value.length > 0) {
        sql.append(" IN (");
        value.forEach((item, i) => {
          sql.append(SQL`${item}`);
          if (i !== value.length - 1) {
            sql.append(",");
          }
        });
        sql.append(") ");
      } else {
        sql.append(SQL`LIKE ${"%" + f[i][1] + "%"} `);
      }

      if (i !== f.length - 1) {
        sql.append("AND ");
      }
    }
  }

  if (customFilters && Object.entries(customFilters).length > 0) {
    if (filters && Object.entries(filters).length > 0) {
      sql.append(" AND ");
    }

    const f = Object.entries(customFilters);

    for (let i = 0; i < f.length; i++) {
      sql.append(f[i][1].field);
      const value = f[i][1].comparison;

      if (Array.isArray(value) && value.length > 0) {
        sql.append(" IN (");
        value.forEach((item, i) => {
          sql.append(SQL`${item}`);
          if (i !== value.length - 1) {
            sql.append(",");
          }
        });
        sql.append(") ");
      } else {
        sql.append(SQL`LIKE ${"%" + f[i][1] + "%"} `);
      }

      if (i !== f.length - 1) {
        sql.append("AND ");
      }
    }
  }

  if (sort) {
    sql.append(`ORDER BY ${SqlString.escapeId(sort[0])} ${sort[1] === "ASC" ? "ASC" : "DESC"} `);
  }

  if (range) {
    sql.append(SQL`LIMIT ${range[0]},${range[1] - range[0]} `);
  }
}
