A property is named by its number, such as `123456789`. `int_google_analytics_list_accounts` lists the accounts you can see, each with its properties as `properties/123456789`: use only the number.

A report needs a date range, at least one metric, and usually a dimension to split it by:

`{"property": "123456789", "dateRanges": [{"startDate": "28daysAgo", "endDate": "yesterday"}], "metrics": [{"name": "activeUsers"}], "dimensions": [{"name": "date"}]}`

Dates are `YYYY-MM-DD`, `today`, `yesterday` or `NdaysAgo`. Useful metrics: `activeUsers`, `sessions`, `screenPageViews`, `engagementRate`, `keyEvents`, `totalRevenue`. Useful dimensions: `date`, `pagePath`, `sessionSource`, `sessionMedium`, `country`, `deviceCategory`. `int_google_analytics_get_metadata` lists every one a property has.

Rows come back as `dimensionValues` and `metricValues` in the order you asked for them. Today's numbers are still filling in; use `int_google_analytics_run_realtime_report` for the last half hour.

Everything here only reads. Report numbers as they came back, with the date range they cover.
