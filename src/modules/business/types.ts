import type { BusinessParams, BusinessRow } from './client'

export type Copy = string
export interface BusinessColumn { key: string; label: Copy; format?: 'money' | 'percent' | 'date' | 'status' | 'boolean' }
export interface BusinessField {
  key: string; label: Copy; type?: 'decimal' | 'integer' | 'select' | 'textarea' | 'text'; required?: boolean;
  options?: Array<{ value: string; label: Copy }>; default?: string; from?: string; readonly?: boolean;
  max?: string; scale?: number; zero?: boolean; hint?: Copy;
  optionsFrom?: { section: string; key: string };
}
export interface BusinessAction {
  id: string; label: Copy; path: string; fields: BusinessField[]; note: Copy;
  defaults?: BusinessParams; visible?: (row: BusinessRow) => boolean;
  preview?: { path: string; fields: string[]; columns: BusinessColumn[]; rowsPath?: string; when?: (form: BusinessParams) => boolean };
  inspect?: { path: string; idKey: string; queryKey?: string; columns: BusinessColumn[]; rowsPath?: string; singleton?: boolean };
}
export interface BusinessSection {
  id: string; label: Copy; path: string; rowsPath?: string; singleton?: boolean; public?: boolean; paging?: boolean;
  columns: BusinessColumn[]; actions?: BusinessAction[]; empty: Copy; note?: Copy;
}
export interface BusinessDefinition { id: string; title: Copy; intro: Copy; sections: BusinessSection[]; actions?: BusinessAction[]; notice?: Copy }
