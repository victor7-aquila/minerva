/** 페이지 응답이다. */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}
