import type {
  ClassificationDataset,
  EmailPresentation,
  ReviewQueueItem,
} from "@/types/averis";

export const classificationData: ClassificationDataset = {
  email_001: {
    email_id: "email_001",
    category: "comparison_request",
    confidence: 0.984,
    status: "mismatch",
    needs_review: true,
    review_reason: null,
    comparison: {
      si_doc_type_detected: "SI",
      bl_doc_type_detected: "BL",
      fields: [
        {
          field: "bl_number",
          si_value: "SI-9920334",
          bl_value: "BL-9920334",
          match: true,
        },
        {
          field: "vessel_name",
          si_value: "MAERSK ALABAMA",
          bl_value: "MAERSK ALABAMA",
          match: true,
        },
        {
          field: "consignee_name",
          si_value: "Global Logistics Corp",
          bl_value: "Global Logistics Corp",
          match: true,
        },
        {
          field: "tax_id",
          si_value: "99-2837465",
          bl_value: "99-2837466",
          match: false,
        },
        {
          field: "address",
          si_value: "123 Harbor Way, Singapore",
          bl_value: "123 Harbor Rd, Singapore",
          match: false,
        },
        {
          field: "container_id",
          si_value: "MSKU8829330",
          bl_value: "MSKU8829330",
          match: true,
        },
        {
          field: "gross_weight",
          si_value: "24,500 KG",
          bl_value: "24,480 KG",
          match: false,
        },
      ],
      summary: "3 of 7 fields mismatched: tax_id, address, gross_weight",
    },
  },
  email_007: {
    email_id: "email_007",
    category: "comparison_request",
    confidence: 0.95,
    status: "match",
    needs_review: false,
    review_reason: null,
    comparison: {
      si_doc_type_detected: "SI",
      bl_doc_type_detected: "BL",
      fields: [
        {
          field: "bl_number",
          si_value: "SI-2024-0015",
          bl_value: "BL-883210",
          match: true,
        },
        {
          field: "vessel_name",
          si_value: "MSC INES",
          bl_value: "MSC INES",
          match: true,
        },
        {
          field: "consignee_name",
          si_value: "Kuehne + Nagel Intl",
          bl_value: "Kuehne + Nagel Intl",
          match: true,
        },
        {
          field: "container_id",
          si_value: "TGHU9918231",
          bl_value: "TGHU9918231",
          match: true,
        },
      ],
      summary: "No mismatch detected.",
    },
  },
  email_507: {
    email_id: "email_507",
    category: "comparison_request",
    confidence: 0.9,
    status: "escalated",
    needs_review: true,
    review_reason: {
      code: "comparison_request_missing_bl",
      message: "Comparison request has no BL attachment to compare against.",
    },
    comparison: null,
  },
  email_002: {
    email_id: "email_002",
    category: "invoice_query",
    confidence: 0.97,
    status: "not_applicable",
    needs_review: false,
    review_reason: null,
    comparison: null,
  },
};

export const emailPresentation: Record<string, EmailPresentation> = {
  email_001: {
    sender: "Maersk Logistics Services",
    initials: "ML",
    subject: "BL-9421882 - Port of Singapore to R",
    reference: "SI-2024-0012",
    received: "10:42 AM",
  },
  email_new_si: {
    sender: "Kuehne + Nagel Intl",
    initials: "KN",
    subject: "HBL #883210 - Shanghai Terminal",
    reference: "SI-2024-0015",
    received: "09:15 AM",
  },
  email_002: {
    sender: "DHL Global Forwarding",
    initials: "DG",
    subject: "AWB-771290 - Frankfurt Express Hu",
    reference: "SI-2024-0019",
    received: "Yesterday",
  },
  email_general: {
    sender: "MSC Mediterranean Shipping",
    initials: "MS",
    subject: "SWB-654012 - Jebel Ali Port Entry",
    reference: "SI-2024-0022",
    received: "Yesterday",
  },
  email_spam: {
    sender: "CMA CGM Logistics",
    initials: "CC",
    subject: "BL-550133 - Marseille Docks",
    reference: "SI-2024-0025",
    received: "Oct 24, 2023",
  },
};

export const supplementalEmails = [
  {
    email_id: "email_new_si",
    category: "new_si_request" as const,
    confidence: 0.621,
    status: "not_applicable" as const,
    needs_review: false,
    review_reason: null,
    comparison: null,
  },
  {
    email_id: "email_general",
    category: "general" as const,
    confidence: 0.92,
    status: "not_applicable" as const,
    needs_review: false,
    review_reason: null,
    comparison: null,
  },
  {
    email_id: "email_spam",
    category: "spam" as const,
    confidence: 0.452,
    status: "not_applicable" as const,
    needs_review: false,
    review_reason: null,
    comparison: null,
  },
];

export const reviewQueue: ReviewQueueItem[] = [
  {
    id: "REV-9402",
    emailId: "email_001",
    reference: "BL-2024-00129",
    issue: "Critical Weight Mismatch",
    assignee: "Marcus Chen",
    pending: "4h 12m",
    priority: "high",
    requiresReview: true,
  },
  {
    id: "REV-9405",
    emailId: "email_507",
    reference: "BL-2024-00145",
    issue: "Vessel Name Discrepancy",
    assignee: "Sarah Jenkins",
    pending: "1h 45m",
    priority: "high",
    requiresReview: true,
  },
  {
    id: "REV-9410",
    emailId: "email_007",
    reference: "BL-2024-00158",
    issue: "Invalid Port Code",
    assignee: "Unassigned",
    pending: "22m",
    priority: "medium",
    requiresReview: false,
  },
  {
    id: "REV-9412",
    emailId: "email_002",
    reference: "BL-2024-00162",
    issue: "Formatting Error",
    assignee: "Marcus Chen",
    pending: "15m",
    priority: "low",
    requiresReview: false,
  },
];

export const categoryLabels = {
  comparison_request: "Comparison Request",
  new_si_request: "New SI Request",
  invoice_query: "Invoice Query",
  general: "General",
  spam: "Spam",
} as const;
