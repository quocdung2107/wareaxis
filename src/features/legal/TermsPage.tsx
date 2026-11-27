import { Card } from '../../shared/ui/ui'

/** Phiên bản điều khoản hiện hành của lớp trung gian giao tiếp (Bản A mục 3.8). */
export const TERMS_VERSION = 'v1'
export const TERMS_EFFECTIVE_DATE = '27/11/2026'

const SECTIONS: { title: string; body: string[] }[] = [
  {
    title: '1. Hệ thống chỉ là công cụ giao tiếp và ghi nhận',
    body: [
      'WareAxis (phần "Tìm xe & chuyến" — lớp trung gian giao tiếp Kho ↔ Vận tải) là công cụ để các đơn vị có hàng và các đơn vị vận tải tự tìm thấy nhau, trao đổi, chốt chuyến và ghi lại quá trình giao nhận.',
      'Hệ thống KHÔNG phải là một bên tham gia giao dịch vận tải, không phải đơn vị vận tải, không phải bên môi giới đứng ra bảo lãnh, và không cam kết về chất lượng dịch vụ, khả năng thực hiện chuyến hay khả năng thanh toán của bất kỳ bên nào.',
    ],
  },
  {
    title: '2. Thông tin hồ sơ là do đơn vị tự khai và tự chịu trách nhiệm',
    body: [
      'Mọi thông tin trong hồ sơ tổ chức, hồ sơ kho, xe, tài xế và tuyến vận tải (bao gồm tên pháp nhân, mã số thuế, số giấy phép, biển số, hạng bằng lái và các mốc ngày hết hạn giấy tờ) đều do chính đơn vị tự khai.',
      'Đơn vị tự khai chịu trách nhiệm hoàn toàn về tính đúng đắn, đầy đủ và tính pháp lý của thông tin mình đăng, bao gồm cả việc giấy tờ còn hiệu lực hay không. Hệ thống không xác thực, không phê duyệt và không kết luận thông tin nào là "đạt yêu cầu".',
      'Các mốc ngày hết hạn giấy tờ (nếu có) chỉ được hiển thị như thông tin để các bên tự đọc và tự đánh giá.',
    ],
  },
  {
    title: '3. Các bên tự xác minh trước khi giao dịch và tự chịu trách nhiệm về giao dịch của mình',
    body: [
      'Trước khi chốt chuyến, mỗi bên có trách nhiệm tự xác minh đối tác (giấy tờ, năng lực, điều kiện vận tải theo quy định pháp luật hiện hành) bằng các kênh của mình.',
      'Giá cước, điều kiện chuyến và mọi thoả thuận là do hai bên tự thương lượng và xác nhận. Việc một chuyến được ghi lại trong hệ thống không có nghĩa là hệ thống bảo đảm cho thoả thuận đó.',
      'Khi có tranh chấp, hệ thống chỉ cung cấp dữ liệu đã ghi (lịch sử sự kiện chuyến, nội dung trao đổi, bằng chứng giao hàng, giá đã chốt) để hai bên tự đối chiếu và tự giải quyết với nhau hoặc thông qua cơ quan có thẩm quyền theo pháp luật. Hệ thống không phân xử tranh chấp.',
    ],
  },
  {
    title: '4. Thanh toán nằm ngoài hệ thống',
    body: [
      'Hệ thống không xử lý thanh toán, không giữ tiền hộ, không thu phí giao dịch và không xuất hoá đơn. Mọi khoản cước và phụ phí do hai bên tự thanh toán với nhau ngoài hệ thống; các con số trong mục ghi nhận cước chỉ là ghi chép do hai bên tự khai và xác nhận lẫn nhau.',
    ],
  },
  {
    title: '5. Dữ liệu vị trí (khi tài xế bật chia sẻ)',
    body: [
      'Vị trí của tài xế chỉ được ghi lại trong thời gian chuyến đang chạy và chỉ khi chính tài xế chủ động bật chia sẻ vị trí. Tài xế có thể tắt chia sẻ bất cứ lúc nào. Dữ liệu vị trí chỉ hiển thị cho hai phía trong chuyến liên quan.',
    ],
  },
  {
    title: '6. Thay đổi điều khoản',
    body: [
      'Điều khoản có thể được cập nhật theo phiên bản. Phiên bản đang hiển thị là phiên bản đang áp dụng; khi có thay đổi trọng yếu, hệ thống sẽ thông báo trong ứng dụng trước khi áp dụng.',
    ],
  },
]

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Card className="space-y-2">
        <h2 className="text-xl font-bold">Điều khoản sử dụng — Lớp trung gian giao tiếp Kho ↔ Vận tải</h2>
        <p className="text-slate-600">
          Phiên bản {TERMS_VERSION} · Áp dụng từ {TERMS_EFFECTIVE_DATE}. Điều khoản này áp dụng cho phần tính năng tìm xe,
          chốt chuyến và theo dõi chuyến giữa các đơn vị sử dụng WareAxis.
        </p>
      </Card>
      {SECTIONS.map((s) => (
        <Card key={s.title} className="space-y-2">
          <h3 className="text-lg font-semibold">{s.title}</h3>
          {s.body.map((p, i) => (
            <p key={i} className="leading-relaxed text-slate-700">{p}</p>
          ))}
        </Card>
      ))}
      <p className="text-sm text-slate-500">
        Đây là điều khoản tối thiểu phục vụ vận hành tự khai — tự xác minh — tự chịu trách nhiệm. Nội dung đầy đủ về pháp
        lý (trách nhiệm nền tảng, dữ liệu cá nhân, hợp đồng điện tử…) đang nằm trong danh mục nghiên cứu tiếp theo của dự án.
      </p>
    </div>
  )
}
