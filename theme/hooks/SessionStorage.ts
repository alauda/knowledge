import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "rspress/runtime";

export const SEARCH_PARAMS_SESSION_KEY = "ac-knowledge-searchParams";
export const PRODUCTS_SESSION_KEY = "ac-knowledge-products";
export const KINDS_SESSION_KEY = "ac-knowledge-kinds";
export const KEYWORD_SESSION_KEY = "ac-knowledge-keyword";

function parseJson<T>(str: string): T | null {
  try {
    return JSON.parse(str) as T;
  } catch {
    return null;
  }
}
export const useSessionStorage = <T>(
  key: string,
  initialValue: T
): [T, (value: T) => void] => {
  const [value, setValue] = useState<T>(initialValue);

  useEffect(() => {
    const storedValue = sessionStorage.getItem(key);

    if (storedValue) {
      const value = parseJson<T>(storedValue);
      if (value) {
        setValue(value);
      }
    }
  }, [key]);

  const setStorageValue = useCallback(
    (value: T) => {
      setValue(value);
      sessionStorage.setItem(key, JSON.stringify(value));
    },
    [key]
  );

  return [value, setStorageValue];
};

export const usePersistSearchParams = (): [
  URLSearchParams,
  (value: URLSearchParams) => void
] => {
  const [storedValue, setStoredValue] = useSessionStorage<Record<string, any>>(
    SEARCH_PARAMS_SESSION_KEY,
    {} as URLSearchParams
  );
  const [searchParams, setSearchParams] = useSearchParams(storedValue || {});

  useEffect(() => {
    setSearchParams(storedValue);
  }, [storedValue]);

  const onSearchParamsChange = (params: URLSearchParams) => {
    setStoredValue(Object.fromEntries(params));
  };
  return [searchParams, onSearchParamsChange];
};
