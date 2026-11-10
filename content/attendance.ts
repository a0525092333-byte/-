export const attendanceContent = {
  manualEntryBadge: "הוזן ידנית",
  manualEditBadge: "שונה ידנית",
  editedBy: (name: string, when: string) => `עודכן ע"י ${name} ב-${when}`,
  editCount: (count: number) => `· ${count} עריכות`,
  enteredBy: (name: string) => `הוזן ע"י ${name}`,
  manualSummary: (count: number) =>
    count === 1 ? "דיווח אחד הוזן או שונה ידנית" : `${count} דיווחים הוזנו או שונו ידנית`,
};
