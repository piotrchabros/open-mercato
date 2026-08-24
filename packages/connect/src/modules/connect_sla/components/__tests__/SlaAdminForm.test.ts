jest.mock("@open-mercato/ui/backend/CrudForm", () => ({
  CrudForm: () => null,
}));
jest.mock("@open-mercato/ui/backend/utils/crud", () => ({
  createCrud: jest.fn(),
  updateCrud: jest.fn(),
}));
jest.mock("@open-mercato/ui/backend/injection/useGuardedMutation", () => ({
  useGuardedMutation: jest.fn(),
}));
jest.mock("@open-mercato/ui/backend/conflicts", () => ({
  surfaceRecordConflict: jest.fn(),
}));
jest.mock("@open-mercato/ui/backend/detail", () => ({
  LoadingMessage: () => null,
  ErrorMessage: () => null,
}));
jest.mock("@open-mercato/ui/backend/Page", () => ({
  Page: ({ children }: { children: unknown }) => children,
  PageBody: ({ children }: { children: unknown }) => children,
}));
jest.mock("@open-mercato/ui/backend/FlashMessages", () => ({
  flash: jest.fn(),
}));
jest.mock("@open-mercato/shared/lib/i18n/context", () => ({ useT: jest.fn() }));
jest.mock("next/navigation", () => ({
  useRouter: jest.fn(),
}));

import { calendarPublication, policyPublication } from "../SlaAdminForm";

const t = ((key: string) => key) as never;

describe("SLA administration forms", () => {
  test("parses calendar windows and optional holiday labels", () => {
    expect(
      calendarPublication(
        {
          timezone: "Europe/Berlin",
          windows: "1,09:00,17:00\n2,10:00,18:00",
          holidays: "2026-12-25,Christmas\n2026-12-26",
        },
        t,
      ),
    ).toEqual({
      timezone: "Europe/Berlin",
      windows: [
        { weekday: 1, localStart: "09:00", localEnd: "17:00" },
        { weekday: 2, localStart: "10:00", localEnd: "18:00" },
      ],
      holidays: [
        { localDate: "2026-12-25", label: "Christmas" },
        { localDate: "2026-12-26", label: null },
      ],
    });
  });

  test("rejects malformed publication lines", () => {
    expect(() =>
      calendarPublication(
        { timezone: "UTC", windows: "1,09:00", holidays: "" },
        t,
      ),
    ).toThrow();
  });

  test("builds policy publication and enforces warnings below targets", () => {
    const values = {
      channelId: "",
      calendarVersionId: "calendar-version",
      responseTargetMinutes: 60,
      resolutionTargetMinutes: 120,
      responseWarningMinutes: 15,
      resolutionWarningMinutes: 30,
      effectiveFrom: "2026-08-24T09:00",
    };
    expect(policyPublication(values, t)).toMatchObject({
      channelId: null,
      responseTargetMinutes: 60,
      resolutionTargetMinutes: 120,
    });
    expect(() =>
      policyPublication({ ...values, responseWarningMinutes: 60 }, t),
    ).toThrow();
  });
});
