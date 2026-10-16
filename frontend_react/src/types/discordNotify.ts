// Discord 通知設定（對應後端 /api/discord-notify/*）

export type NotifyKind = "live" | "video";

export interface NotifyKindConfig {
  enabled: boolean;
  discord_channel_id: string | null;
  role_id: string | null;
  template: string;
}

export interface DiscordNotifyConfig {
  youtube_channel_id: string;
  guild_id: string;
  live: NotifyKindConfig;
  video: NotifyKindConfig;
}

export interface DiscordOption {
  id: string;
  name: string;
}

export interface DiscordGuildOptions {
  guild_id: string;
  channels: DiscordOption[];
  roles: DiscordOption[];
}
