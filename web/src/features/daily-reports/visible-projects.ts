// The server applies the same filter to saved reports it returns; the page
// keeps it so a project hidden while the page is open drops out immediately.
export { excludeArchivedReportProjects } from "@/lib/daily-reports/visible-projects";
