import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';

let osmd: OpenSheetMusicDisplay | null = null;
let lastXml = '';

/** Hiển thị sheet nhạc (MusicXML) trong khung cho trước. */
export async function renderSheet(container: HTMLElement, xml: string): Promise<void> {
  if (xml === lastXml && osmd) return;
  lastXml = xml;
  if (!osmd) {
    osmd = new OpenSheetMusicDisplay(container, {
      autoResize: true,
      backend: 'svg',
      drawTitle: true,
      drawComposer: false,
      drawPartNames: false,
      drawMeasureNumbers: true,
      drawingParameters: 'default',
      followCursor: false,
    });
  }
  await osmd.load(xml);
  osmd.Zoom = container.clientWidth < 600 ? 0.6 : 0.85;
  osmd.render();
}
