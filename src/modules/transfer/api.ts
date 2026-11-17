import { request } from '@/modules/api/http'
import type { TransferRequest } from './transfer'

/**
 * Sends a transfer built by `buildTransferRequest`. Both endpoints live on the default spot
 * namespace (`/fe-ex-api/`) and answer `code="0"` on success; any other answer throws `ApiError`.
 */
export function submitTransfer(transfer: TransferRequest): Promise<unknown> {
  return request<unknown>(transfer.path, { body: transfer.body })
}
