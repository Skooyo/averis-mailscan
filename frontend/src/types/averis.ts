export type EmailCategory =
  | "comparison_request"
  | "new_si_request"
  | "invoice_query"
  | "general"
  | "spam";

export type EmailStatus = "mismatch" | "match" | "escalated" | "not_applicable";

export interface ComparisonField {
  field: string;
  si_value: string;
  bl_value: string;
  match: boolean;
}

export interface DocumentComparison {
  si_doc_type_detected: "SI";
  bl_doc_type_detected: "BL";
  fields: ComparisonField[];
  summary: string;
}

export interface ReviewReason {
  code: string;
  message: string;
}

export interface ClassifiedEmail {
  email_id: string;
  category: EmailCategory;
  confidence: number;
  status: EmailStatus;
  needs_review: boolean;
  review_reason: ReviewReason | null;
  comparison: DocumentComparison | null;
}

export type ClassificationDataset = Record<string, ClassifiedEmail>;

export interface EmailPresentation {
  sender: string;
  initials: string;
  subject: string;
  reference: string;
  received: string;
}

export interface ReviewQueueItem {
  id: string;
  emailId: string;
  reference: string;
  issue: string;
  assignee: string;
  pending: string;
  priority: "high" | "medium" | "low";
  requiresReview: boolean;
}
