# Import a task file to one destination

Choose **Import tasks CSV** from **Inspection templates**, **Inspections**, or **Job cards**. The existing manual CSV import window also provides **Import task file to one template or inspection**.

1. Select **Inspection template** or **Existing inspection** and choose the destination for the whole file.
2. Optionally select the source PDF manual. Without a selected manual, reference text and PDF page numbers are retained without fabricating a document link.
3. Choose the CSV and **Preview task file**.
4. Review the rows and confirm that every task belongs to the selected destination, then **Import all … tasks**.

The supplied `sample task csv.csv` is supported directly. It contains 14 Phase 2 tasks, references to section 5-12-02, and original PDF pages 79–80. Its header is:

```csv
Item code,Task,Zone,Manual reference,PDF page
```

An optional `Applicability` column is supported. Use UTF-8 CSV with normal quoting for commas, quotes and multiline text. Each row needs a unique item code and nonempty task instruction. Zone/reference/page fields may be blank if unknown; if a source PDF is selected, every row requires a valid page within that PDF. The upload limit is 2 MB / 2,000 task rows. The downloadable format has the same five columns as the sample.

The existing `tasks.csv` format from the maintenance CSV workflow is also accepted. In this whole-file workflow, the chosen destination replaces the CSV’s parent IDs and parent types. They are not used to route individual rows. No database IDs need to be added to the sample format.

Template imports append the tasks in file order to the reusable checklist, preserving zones, applicability, reference wording, PDF pages and any selected manual links. Existing intervals and conditions are preserved; no compliance history is requested. These tasks are copied when future schedules are created from the template. Adding tasks to a template does not modify inspections already created from it; import to that inspection directly if needed.

Inspection imports create one reusable task template per row, with its instruction in the description and empty execution values. Cards retain the item code, zone and maintenance-data reference. Card numbers are generated separately so the same manual task can be used on multiple inspections or aircraft.

Each batch is atomic. Duplicate item codes within the file, existing matching tasks on the selected destination, stale target versions, invalid pages, archived targets and insufficient maintenance permission are rejected without saving a partial batch. Repeat upload is not an update action. Edit existing records or remove already-imported tasks from the source file before retrying.
