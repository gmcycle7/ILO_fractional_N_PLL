import { useEffect, useState } from 'react';
import { getChartTheme, subscribeTheme, type ChartTheme } from './theme';

/**
 * React hook returning the current ChartTheme tokens; re-renders on
 * light/dark toggle. Chapters should include the returned object in the
 * dependency list of the useMemo that builds chart options, so explicit
 * series colors follow the theme:
 *
 *   const ct = useChartTheme();
 *   const option = useMemo(() => makeLineOption({...}), [data, ct]);
 */
export function useChartTheme(): ChartTheme {
  const [theme, setTheme] = useState<ChartTheme>(getChartTheme);
  useEffect(() => subscribeTheme(() => setTheme(getChartTheme())), []);
  return theme;
}
