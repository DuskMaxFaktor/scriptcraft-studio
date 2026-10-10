export type FileLanguage = 
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'html'
  | 'css'
  | 'bash'
  | 'powershell'
  | 'sql'
  | 'json'
  | 'markdown'
  | 'text';

export interface FileItem {
  id: string;
  name: string;
  language: FileLanguage;
  content: string;
  isEntry?: boolean;
  updatedAt: number;
}

export type LogType = 'log' | 'info' | 'warn' | 'error' | 'system' | 'success';

export interface LogEntry {
  id: string;
  type: LogType;
  message: string;
  timestamp: string;
  /** Set when a line that was being written live (e.g. an input prompt) is complete */
  final?: boolean;
}

export interface AIRole {
  id: string;
  name: string;
  badge: string;
  description: string;
  systemInstruction: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: string;
  modelUsed?: string;
  roleUsed?: string;
  attachedCodeSnippet?: {
    filename: string;
    language: string;
    code: string;
  };
  /** Images attached by the user (base64, no data: prefix) — sent to vision models */
  images?: { mime: string; data: string }[];
  /** Text/code files attached to the message (their content went into the prompt) */
  attachedFiles?: { name: string; size: number }[];
}

export interface ModelOption {
  id: string;
  name: string;
  tag: string;
  desc: string;
  speed: 'fast' | 'balanced' | 'deep';
}

export interface TableData {
  columns: string[];
  rows: (string | number | boolean | null)[][];
  /** Shortened SQL statement that produced this result */
  statement?: string;
  /** Row count before truncation */
  totalRows?: number;
}

export interface TemplateProject {
  id: string;
  name: string;
  description: string;
  category: 'python' | 'web' | 'scripts' | 'database' | 'bots' | 'games';
  /** Emoji shown on the template card */
  icon?: string;
  /** Installed into the project right after it is created */
  packages?: { pip?: string[]; npm?: string[] };
  files: Array<{
    name: string;
    language: FileLanguage;
    content: string;
    isEntry?: boolean;
  }>;
}

/** A non-text file of the project (image, SQLite database, sound, video...) shown under "Other files". */
export interface ProjectAsset {
  name: string;
  size: number;
  kind: 'image' | 'sqlite' | 'audio' | 'video' | 'binary' | 'other';
  mtime: number;
}
