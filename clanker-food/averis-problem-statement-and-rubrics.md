# Shipping document verification
### From email inbox to discrepancy report

## Summary
Averis receives high volumes of shipping operational emails requiring staff to compare Shipping Instructions (SI) against draft Bills of Lading (BL). Participants must build an automated system to classify emails, extract shipment fields, detect mismatches across 7 key attributes (shipper, consignee, notify party, ports, container count, and gross weight), and escalate complex edge cases to human reviewers.

## Tags
* Email Classification
* Document Field Extraction
* 7-Field Discrepancy Detection
* Human-in-the-Loop Escalatio

## Context

A shipping operations team receives different kinds of messages in the same inbox: requests to check documents, prepare new shipping instructions, answer invoice questions, and share operational updates. Spam arrives alongside them.

For a document-checking request, the team compares a Shipping Instruction (SI), which contains the
intended shipment details, with a draft Bill of Lading (BL). The SI is the reference for this check. The goal is to catch incorrect details before the draft is finalized.

## The problems

* **Finding the right emails takes time.** Staff must read each message and decide what action it needs. A document request that is overlooked never reaches the checking step.

* **Manual comparison is repetitive and easy to get wrong.** Names, ports, quantities, and weight must be checked across two documents. A missed discrepancy can lead to corrections, delays, and additional work.

* **The same information can look different.** One document may say “Port of Loading” while the other says “Load Port.” The system needs to recognize that these refer to the same field.

## What the system should be able to do

Starting from the inbox, the system should produce a clear result for each email. How you design the workflow is up to you, but it should generally be able to:


| Capability | What it means |
| :--------- | :------------ | 
| **Classify** | Tell the different kinds of messages apart, including document-comparison requests, new SI requests, invoice queries, general messages, and spam. |
| **Extract data** | For comparison requests, read the SI and BL attachments and identify the corresponding shipment fields.
| Compare | Check the values and surface any mismatched fields, showing the SI and BL values side by side.
| **Ask for help** | When it cannot complete the task on its own, escalate to a person (human in the loop) with the relevant context, rather than guessing or failing silently. |

The starting version uses JSON email records and plain-text attachments. Other email categories only need to be classified; only document-comparison requests continue to the checking step. The approach used to achieve these capabilities is left to the participant.

# Expected result and extensions
## What the comparison covers

Check seven fields: **shipper, consignee, notify party, port of loading, port of discharge, container count, and gross weight in kilograms.**

The report should make it easy to see which email was checked, whether a mismatch was found, and exactly what needs attention. If all seven fields match, report “No mismatch detected.”

> **Example**  
> The SI lists 3 containers and 22,000 kg. The BL lists 4 containers and 22,000 kg. If the other fields agree, flag only the container count and show SI: 3 / BL: 4.

## Advanced stage
Classifying emails, extracting fields from plain text, and comparing values are the basic, common expectations. Once that works, we encourage you to go further and attempt a more advanced solution using the sample data we provide, which includes more realistic documents and harder decisions.

| Advanced challenge | What changes |
| :----------------- | :----------- |
| **PDF and Word attachments** | Replace plain-text attachments with PDFs and Word documents. You need to extract information from tables and different page layouts.|
| **Scanned documents** | Use image-only PDFs or scanned pages. You can use optical character recognition (OCR), a vision-capable LLM, or both to read and compare the content. |
| **Messier inputs** | Introduce varied field labels, formatting differences, misleading email subjects, or missing attachments. The system must distinguish a real discrepancy from a reading or formatting issue. |
| **Reliability and human review** | When a document is unreadable, a required value is missing, or the result is uncertain, send the case for review with the source evidence and reason. Let a person confirm or correct it, then update the report. Handle processing failures visibly and allow retries. |

**Accuracy** means identifying the right requests and the right discrepancies without creating false alarms. The reliability challenge considers what happens when the system cannot make a dependable decision, including when human input is needed.

The basic use case remains the same at every stage: find the document request, compare the shipment details, and explain any mismatch. The advanced stage is where you can stand out by handling the harder, more realistic sample data.

# Working with the data

The dataset contains inbox records in JSON, together with the SI and BL attachments referenced by those emails. The answer key is not included. You can check your result using the self-evaluation endpoint described on the next page.

## Two ways to access the data

| Option | How you use it | 
| :----- | :------------- |
| **Static bundle** | A ZIP file containing inbox/, attachments/, sample_submission.json, and a helper file called loader.py. Extract the ZIP and read the files directly. No service needs to be started. |
| **Local server (Docker)** | Run docker compose up --build to access the same dataset over HTTP at http://localhost:8080. No database or additional setup is required. |

## The loader
The included loader.py provides the same interface for both options. Point it to either the extracted data folder or the local server:

> **Example**
> 
> from loader import Inbox  
> 
> inbox = Inbox("data")  — or  Inbox("http://localhost:8080")
> 
> for email in inbox: reads each email record, while inbox.read_text(path) returns the text from an SI or BL attachment.

Start with one email and its two attachments so you can see how the records are connected. The participant guide included with the data explains the access options and the fields in detail.


# Evaluating your own output
How you design your system and what it produces internally is entirely up to you. To help you gauge how well it is doing, the local server includes an optional self-evaluation endpoint. Submit your result and the server compares it with a private reference set, then returns a scoreboard. The reference answers are not included in the response.

## Formatting your output for the self-evaluation

The self-evaluation only needs your output in one agreed shape so it can be read automatically: one JSON object keyed by email_id, following the format in sample_submission.json. Include every email in the dataset, and for a document-comparison request report its category, whether a mismatch was found, and the fields that differ. This shape is only required if you want to use the self-evaluation — it is not a constraint on how your system works internally.

> **How to run it**
> 
> With the local server running, send your formatted output to POST /submit or call inbox.submit(...) through the loader. The response contains the evaluation result without exposing the reference answers.

## How to use the result
The scoreboard is meant to help you find problems while you build. It is not the final assessment and does not cover every part of a good solution.

* Check where your system classified an email incorrectly or missed a document mismatch.
* Review cases where the input was incomplete or uncertain. A score cannot fully assess whether the
system asked for human review at the right time or provided enough context.
* If your result differs from the reference, check the source documents before changing it. If your decision is reasonable, record the reason.

You can submit your output as often as needed while developing. Use the result to improve accuracy, and separately test how your system behaves when information is missing, unclear, or unreadable.

# Submission Components

## Project Description (Mandatory)
* Brief summary of the project, including its name, purpose and problem statement.

## Demo Video Link (Mandatory)
* Overview of the project, showcasing its functionality.
* Explaining key features and how technologies are integrated.
* Demonstration of the working prototype.
* The youtube video can be either unlisted or public. Private video will not be entertained. 
* Google drive links need to be shared as "Anyone with the link → Viewer".
* Video should cover:
    * Quick Intro - Team name & project name
    * The Problem - Who it affects and why it matters
    * Tech Stack - Key technologies used
    * Live Demo - Walkthrough of your working prototype
    * Impact - Metrics, results, or user feedback
    * Maximum duration is 5 minutes
    * For every 30-second delay, 1 mark will be deducted.

## GitHub Repository Link (Mandatory)
* Link to the project’s source code with a clear README file that includes setup instructions.

## Live Prototype / Demo Link (Mandatory)
* Provide a publicly accessible link to the deployed project.
* The deployment should be functional and accessible to the judges during the judging period.


## Slide Deck / Documentation Link (Mandatory)
* Provide a publicly accessible link to slide deck or project documentation (e.g. Google Slides, PDF uploaded to Google Drive, Notion, GitHub README).
* This should include:
    * Technical Architecture
    * Implementation Details
    * Challenges Faced
    * Future Roadmap


## Demo Video Link

# Submission Guidelines
* The submitted solution must incorporate Artificial Intelligence (AI) Technology as a key component.
* All work on the project must be completed during the official duration of the hackathon.
* The submission and all its components must be the team's original work. While referencing existing solutions is permitted, direct plagiarism of ideas, code, or designs is strictly prohibited.
* Participants are not allowed to plagiarize the ideas, work, or submissions of other teams.
* All submissions must be made before the specified deadline. Any incomplete, illegible, misdirected, or late submissions will not be considered.
* Submissions that contain or promote dangerous, vulgar, offensive, indecent, illegal, racist, plagiarized, cruel, or fraudulent content—or that infringe on the rights or copyright of others—will cause immediate disqualification.

# Submision Criteria

## Preliminary Round Requirements
* At a minimum, your submission should be a low-code solution.
* A semi-working prototype is strongly encouraged.
* No-code submissions will not be accepted.
* Slide deck, video demo and prototype link has to be submitted. 

## Final Round Requirements
* A working prototype is expected from the participants
* The final submission should be an extension and improvement of your preliminary round entry

## AI Usage Requirement
All submissions must incorporate AI and utilize cloud infrastructure as part of the solution’s development, deployment or core functionality.
Solutions that do not meaningfully integrate cloud infrastructure may receive significantly reduced scores.

# Rubrics
**Scoring overview**  
**100 points total: Technical 70 points • Product & Impact 30 points**  
The largest single criterion is Working Core Prototype at 25 points.

## Scoring Rubric (100%)
* 25% - Working Core Prototype
* 15% - System Design & Architecture
* 15% - Technical Feasability & Validation
* 10% - Problem Statement Understanding
* 10% - Innovation & Solution Approach
* 10% - Practical Value & Potential

## How to mark
• Score all seven criteria using whole numbers.  
• Use the performance bands as guidance and score each criterion independently.  
• Do not reward the same evidence twice.  
• Base scores on what is demonstrated, submitted or clearly explained.

| Category | Weak | Developing | Strong | Excellent |
| :---: | :---- | :---: | :---- | :---- |
| 10-point criterion | 0–2 | 3–5 | 6–7 | 8–10 |
| 15-point criterion | 0–3 | 4–7 | 8–11 | 12–15 |
| 25-point criterion | 0–6 | 7–12 | 13–18 | 19–25 |

## TECHNICAL — 70 POINTS

| No. | Criterion | Max | What judges assess | Weak | Developing | Strong | Excellent |
| :---: | :---- | :---: | :---- | :---- | :---- | :---- | :---- |
| 1 | System Design & Architecture | 15 | How well the solution is structured, including its main components, data flow, interfaces and dependencies. | Architecture is unclear or key components are missing. | A basic architecture is shown, but important links or decisions are unclear. | Architecture and data flow are clear, with sensible component choices. | Architecture is coherent, well justified and supported by the prototype or other technical evidence. |
| 2 | Working Core Prototype | 25 | How much of the core solution is working at the preliminary stage. | The core function does not work or is only shown through slides or mock-ups. | Part of the core works, but key steps rely on placeholders, manual workarounds or unstable connections. | The main flow works end-to-end with only minor gaps. | The core flow works reliably end-to-end and clearly shows that the main technical idea has been built. |
| 3 | Technology Integration | 15 | How appropriately and effectively the chosen technologies, tools, libraries, and APIs are integrated to solve the problem, with no restrictions on tech stack.  | Technology choices are poorly justified or mismatched for the problem; integration is superficial, broken, or primarily cosmetic.  | Technologies are functional within the project, but the integration is basic, relies heavily on boilerplate code, or shows limited technical depth. | Technologies are well-chosen and effectively integrated; components communicate cleanly and meaningfully contribute to the core solution.  | Deep, seamless integration of modern or complex technologies; tools are leveraged to their full potential with strong technical craftsmanship. |
| 4 | Technical Feasibility & Validation | 15 | Whether key technical assumptions have been tested and the team has a realistic path to a complete solution. | Major technical risks are untested or ignored. | Some risks are tested, but important questions remain. | Key risks are tested and important limitations are understood. | Critical assumptions are validated with clear evidence and there is a credible path to completion. |

## PRODUCT & IMPACT — 30 POINTS

| No. | Criterion | Max | What judges assess | Weak | Developing | Strong | Excellent |
| :---: | :---- | :---: | :---- | :---- | :---- | :---- | :---- |
| 5 | Problem Statement Understanding | 10 | How clearly the team understands the given problem statement, affected users or stakeholders, and the need being addressed. | Limited understanding of the problem or who it affects. | The problem is understood at a basic level, but context or needs are unclear. | Clear understanding of the problem and relevant users or stakeholders. | Strong, well-supported understanding of the problem, its context and why it matters. |
| 6 | Innovation & Solution Approach | 10 | How original and suitable the proposed solution is for the problem statement. | The idea is generic or poorly suited to the problem. | The approach is workable but familiar, with limited differentiation. | The approach is thoughtful, relevant and meaningfully differentiated. | The approach is original, well justified and offers a clear advantage. |
| 7 | Practical Value & Potential | 10 | Whether the solution could provide useful value and has a realistic path beyond the preliminary round. | Value is unclear or the idea is not realistically usable. | Some value is visible, but next steps or adoption potential are vague. | Clear practical value with realistic next steps. | Strong practical value with a credible path to wider use or impact. |

> **Scoring note:** use the performance bands as guidance and award a whole-number score within the relevant range. Score each criterion independently and avoid rewarding the same evidence twice.


ingestion + classification -> extraction + db schema -> comparison json of SI and BL -> output pattern matching (case scenarios) =>stream to fe