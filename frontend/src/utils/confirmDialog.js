/**
 * 统一确认框：Modal.confirm 的薄封装，图标换成 Lucide、外观与 RcDialog 一致（圆角、边框、阴影）。
 * 危险操作（okType: 'danger' 或 okButtonProps.danger）用红色警示图标，其余用中性的问号图标。
 * 参数与返回值与 Modal.confirm 完全相同；调用方传入的 icon 会覆盖默认图标，wrapClassName 与统一类名合并。
 */
import { h } from 'vue'
import { Modal } from 'ant-design-vue'
import { CircleHelpIcon, TriangleAlertIcon } from '@lucide/vue'

export function confirmDialog(options = {}) {
  const danger = options.okType === 'danger' || options.okButtonProps?.danger === true
  // 外层沿用 antd 的 anticon 类名，确认框的图标 / 标题 / 正文排版规则才能生效
  const icon = h('span', { class: ['anticon', 'rc-confirm-icon', danger ? 'is-danger' : ''], 'aria-hidden': 'true' }, [
    h(danger ? TriangleAlertIcon : CircleHelpIcon)
  ])
  return Modal.confirm({
    icon,
    ...options,
    wrapClassName: ['rc-confirm-wrap', options.wrapClassName].filter(Boolean).join(' ')
  })
}
