import { toast } from 'sonner'
import type { Channel, SubscriptionModelRefreshResult } from '@proma/shared'

/** 同一渠道重复打开时复用 toast ID，不堆叠授权提示。 */
export function showSubscriptionModelRefreshIssues(result: SubscriptionModelRefreshResult): void {
  for (const issue of result.issues) {
    toast.warning(`${issue.channelName}：${issue.message}`, {
      id: `subscription-model-refresh-${issue.channelId}`,
      duration: issue.requiresAuthorization ? 8000 : 5000,
    })
  }
}

export function getSubscriptionChannelIds(channels: readonly Channel[]): string[] {
  return channels.filter((channel) => channel.provider === 'github-copilot' || channel.provider === 'openai-codex')
    .map((channel) => channel.id)
}
