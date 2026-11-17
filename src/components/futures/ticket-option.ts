/** One entry of a futures ticket dropdown (TicketSelect). */
export interface TicketOption<T extends string = string> {
  value: T
  label: string
  desc?: string
}
