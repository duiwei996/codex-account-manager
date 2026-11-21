// Types matching the Rust backend

export type AuthMode = "api_key" | "chat_g_p_t";
export type DockDisplayMode = "show_in_dock" | "menu_bar_only";

export interface AccountInfo {
  risk_controlled?: boolean;
  id: string;
  name: string;
  email: string | null;
  plan_type: string | null;
  subscription_expires_at: string | null;
  auth_mode: AuthMode;
  is_active: boolean;
  credentials_invalid?: boolean;
  created_at: string;
  last_used_at: string | null;
}

export interface UsageInfo {
  from_cache?: boolean;
  /** Local timestamp of the last successful quota query. */
  recorded_at?: string;
  account_id: string;
  plan_type: string | null;
  primary_used_percent: number | null;
  primary_window_minutes: number | null;
  primary_resets_at: number | null;
  secondary_used_percent: number | null;
  secondary_window_minutes: number | null;
  secondary_resets_at: number | null;
  has_credits: boolean | null;
  unlimited_credits: boolean | null;
  credits_balance: string | null;
  error: string | null;
}

export interface AccountResetCredit {
  id: string;
  reset_type: string;
  status: string;
  granted_at: string | null;
  expires_at: string | null;
  redeem_started_at: string | null;
  redeemed_at: string | null;
  title: string | null;
  description: string | null;
}

export interface AccountResetCredits {
  available_count: number;
  next_expires_at: string | null;
  credits: AccountResetCredit[];
}

export interface OAuthLoginInfo {
  auth_url: string;
  callback_port: number;
}

export interface AccountWithUsage extends AccountInfo {
  metadata_recorded_at?: string;
  usage?: UsageInfo;
  usageLoading?: boolean;
}

export interface CodexProcessInfo {
  count: number;
  background_count: number;
  can_switch: boolean;
  pids: number[];
}

export interface WarmupSummary {
  total_accounts: number;
  warmed_accounts: number;
  failed_account_ids: string[];
}

export interface ImportAccountsSummary {
  affected_account_ids: string[];
  total_in_payload: number;
  imported_count: number;
  skipped_count: number;
}
