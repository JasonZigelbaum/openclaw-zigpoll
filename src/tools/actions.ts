import { Type } from "typebox";
import { ZigpollError, type ZigpollClient } from "../api.js";
import { stripHtml } from "../aggregate.js";
import { text, type ZigpollTool } from "../types.js";

const SLIDE_TYPES = [
  "question", "checkbox", "dropdown", "autocomplete", "image-choice", "binary",
  "legal-consent", "inline-multiple-choice", "star-rating", "range",
  "satisfaction", "slider", "short-answer", "long-answer", "email-capture",
  "phone-capture", "date", "file-upload", "country", "rank", "form", "copy",
  "thank-you", "reward", "action", "matrix",
] as const;

export function actionTools(client: ZigpollClient): ZigpollTool[] {
  return [
    {
      name: "zigpoll_create_poll",
      description:
        "Create a new survey (poll). It starts hidden with no slides — add questions with zigpoll_create_slide, then make it live with zigpoll_publish_poll.",
      parameters: Type.Object({
        title: Type.String({ description: "Survey title." }),
        account_id: Type.Optional(
          Type.String({ description: "Account to create the poll in. Omit to use the configured default." }),
        ),
        page_rules: Type.Optional(
          Type.Array(Type.String(), { description: "URL patterns where the on-site survey should appear." }),
        ),
      }),
      async execute(_id, params) {
        const data = await client.post("/poll", {
          accountId: client.resolveAccountId(params.account_id),
          title: params.title,
          pageRules: params.page_rules,
        });
        const poll = data.data ?? data;
        return text(
          `Created poll **${stripHtml(poll.title)}** (id: ${poll._id}). It is hidden and has no slides yet — add slides, then publish.`,
          { poll },
        );
      },
    },
    {
      name: "zigpoll_create_slide",
      description:
        "Add a slide (question) to a poll. Choice types (question, checkbox, dropdown, binary, etc.) need answers; copy/thank-you slides are content-only.",
      parameters: Type.Object({
        poll_id: Type.String(),
        type: Type.Union(SLIDE_TYPES.map((t) => Type.Literal(t))),
        title: Type.Optional(Type.String({ description: "Question text shown to respondents." })),
        subtitle: Type.Optional(Type.String()),
        answers: Type.Optional(
          Type.Array(Type.Object({ title: Type.String() }), {
            description: "Answer options for choice-type slides.",
          }),
        ),
        multi: Type.Optional(Type.Boolean({ description: "Allow selecting multiple answers." })),
        idx: Type.Optional(Type.Number({ description: "Insert position (0-based). Appends by default." })),
      }),
      async execute(_id, params) {
        const data = await client.post("/slide", {
          pollId: params.poll_id,
          type: params.type,
          title: params.title,
          subtitle: params.subtitle,
          answers: params.answers,
          multi: params.multi,
          idx: params.idx,
        });
        const slide = data.data ?? data;
        return text(
          `Added ${params.type} slide **${stripHtml(slide.title) || "(untitled)"}** (id: ${slide._id}) to poll ${params.poll_id}.`,
          { slide },
        );
      },
    },
    {
      name: "zigpoll_publish_poll",
      description: "Make a poll live (visible). Fails if the poll has no slides or is archived.",
      parameters: Type.Object({
        poll_id: Type.String(),
      }),
      async execute(_id, params) {
        const current = await client.get("/poll", { pollId: params.poll_id });
        const poll = current.data ?? current;
        if (poll.isArchived) throw new ZigpollError("Poll is archived — unarchive it before publishing.");
        if (!(poll.slides ?? []).length) throw new ZigpollError("Poll has no slides — add at least one before publishing.");
        if (poll.isVisible) return text(`Poll **${stripHtml(poll.title)}** is already live.`, { poll });
        const data = await client.post("/poll/update", { pollId: params.poll_id, isVisible: true });
        return text(`Poll **${stripHtml(poll.title)}** is now live.`, { poll: data.data ?? data });
      },
    },
    {
      name: "zigpoll_send_survey",
      description:
        "Send a published survey to recipients by email or SMS. The poll must be live first (zigpoll_publish_poll).",
      parameters: Type.Object({
        poll_id: Type.String(),
        channel: Type.Union([Type.Literal("email"), Type.Literal("sms")]),
        recipients: Type.Array(Type.String(), {
          description: "Email addresses or phone numbers, depending on channel.",
        }),
        message: Type.Optional(Type.String({ description: "SMS only: message text sent with the survey link." })),
      }),
      async execute(_id, params) {
        if (params.channel === "email") {
          await client.post("/send-email", { pollId: params.poll_id, recipients: params.recipients });
        } else {
          await client.post("/send-sms", {
            pollId: params.poll_id,
            recipients: params.recipients,
            message: params.message,
          });
        }
        return text(
          `Queued ${params.channel} survey ${params.poll_id} to ${params.recipients.length} recipient(s).`,
          { channel: params.channel, recipients: params.recipients.length },
        );
      },
    },
    {
      name: "zigpoll_survey_link",
      description:
        "Generate a shareable survey link for a poll, optionally tagged with metadata or an expiry date.",
      parameters: Type.Object({
        poll_id: Type.String(),
        metadata: Type.Optional(
          Type.Object({}, { additionalProperties: true, description: "Key/value pairs attached to responses from this link." }),
        ),
        expires_at: Type.Optional(Type.String({ description: "ISO 8601 expiry for the link." })),
      }),
      async execute(_id, params) {
        const data = await client.post("/generate-survey-link", {
          pollId: params.poll_id,
          metadata: params.metadata,
          expiresAt: params.expires_at,
        });
        return text(`Survey link: ${data.url}`, { url: data.url, activityId: data.activityId });
      },
    },
  ];
}
