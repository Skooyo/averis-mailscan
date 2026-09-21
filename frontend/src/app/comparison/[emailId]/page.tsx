import { notFound } from "next/navigation";
import { classificationData, emailPresentation } from "@/data/averis-data";
import { ComparisonScreen } from "@/components/comparison-screen";

interface PageProps {
  params: {
    emailId: string;
  };
}

export default function Page({ params }: PageProps) {
  const email = classificationData[params.emailId];
  if (!email) {
    return notFound();
  }
  const subjectTitle = emailPresentation[params.emailId]?.subject.split(" - ")[0];
  return <ComparisonScreen email={email} subjectTitle={subjectTitle} />;
}
