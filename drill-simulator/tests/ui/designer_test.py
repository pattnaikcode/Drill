# Browser test for the Designer (needs Playwright with Chromium): python3 tests/ui/designer_test.py
# Builds a system from a blank canvas by clicking tiles and dragging connections, edits it, saves it,
# and checks it appears in the instructor page.
import asyncio, json
from playwright.async_api import async_playwright
import pathlib
D = (pathlib.Path(__file__).resolve().parents[2] / 'dist').as_uri() + '/'
async def center(pg, sel):
    b = await pg.locator(sel).first.bounding_box(); return b['x']+b['width']/2, b['y']+b['height']/2
async def drag(pg, a, b):
    x1,y1 = a; x2,y2 = b
    await pg.mouse.move(x1,y1); await pg.mouse.down(); await pg.mouse.move((x1+x2)/2,(y1+y2)/2, steps=4); await pg.mouse.move(x2,y2, steps=4); await pg.mouse.up()
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={'width':1500,'height':950})
        errs=[]; pg.on('pageerror',lambda e:errs.append(str(e))); pg.on('console', lambda m: errs.append('console: '+m.text) if m.type=='error' else None)
        await pg.goto(D+'designer.html'); await pg.wait_for_timeout(600)
        await pg.screenshot(path='/tmp/designer_loaded.png')
        print('loaded nodes:', await pg.locator('#cv [data-node]').count(), '| problems:', await pg.evaluate('window.__designer.check().length'))
        # start blank and build: broker -> gateway -> kafka -> service ; service uses database
        await pg.select_option('#startFrom','blank'); await pg.wait_for_timeout(200)
        for key in ['type:source','type:service','type:kafka_topic','type:service','type:database','type:external_party']:
            await pg.click(f'[data-add="{key}"]'); await pg.wait_for_timeout(80)
        ids = await pg.evaluate('window.__designer.model.components.map(c=>c.id)'); print('added:', ids)
        print('problems before connecting:', await pg.evaluate('window.__designer.check().length'))
        # connect by dragging from handles
        pairs=[(ids[0],ids[1]),(ids[1],ids[2]),(ids[2],ids[3]),(ids[3],ids[5]),(ids[3],ids[4])]
        for a,z in pairs:
            await drag(pg, await center(pg, f'[data-handle="{a}"]'), await center(pg, f'[data-node="{z}"] rect.box'))
            await pg.wait_for_timeout(120)
        m = await pg.evaluate('({edges: window.__designer.model._edges, uses: window.__designer.model.components.filter(c=>c.uses).map(c=>c.id+" uses "+c.uses)})'); print('connected:', m)
        print('problems after connecting:', await pg.evaluate('window.__designer.check()'))
        # move a node by dragging it
        before = await pg.evaluate(f'JSON.stringify(window.__designer.model.diagram.place["{ids[5]}"])')
        x,y = await center(pg, f'[data-node="{ids[5]}"] rect.box'); await drag(pg,(x,y),(x+120,y+160)); await pg.wait_for_timeout(150)
        after = await pg.evaluate(f'JSON.stringify(window.__designer.model.diagram.place["{ids[5]}"])'); print('moved', before, '->', after)
        # select the gateway, rename and set capacity via the properties panel
        await pg.click(f'[data-node="{ids[1]}"] rect.box'); await pg.wait_for_timeout(100)
        await pg.fill('#props input[data-id]', 'oegw'); await pg.press('#props input[data-id]','Tab'); await pg.wait_for_timeout(100)
        await pg.fill('#props input[data-f="name"]', 'Order Entry Gateway'); await pg.press('#props input[data-f="name"]','Tab'); await pg.wait_for_timeout(100)
        print('renamed; edge now:', await pg.evaluate('window.__designer.model._edges[0]'))
        # a bad connection is refused with an explanation
        await drag(pg, await center(pg, '[data-handle="oegw"]'), await center(pg, f'[data-node="{ids[0]}"] rect.box')); await pg.wait_for_timeout(150)
        print('toast:', await pg.inner_text('#toast'))
        # system settings: name, KPI, alert
        await pg.click('#cv rect[data-bg]'); await pg.wait_for_timeout(100)
        await pg.fill('#props input[data-m="system"]','Demo trading flow'); await pg.press('#props input[data-m="system"]','Tab')
        await pg.fill('#props input[data-m="id"]','demo-flow'); await pg.press('#props input[data-m="id"]','Tab'); await pg.wait_for_timeout(100)
        await pg.fill('#kLabel','Orders not processed'); await pg.select_option('#kAt', ids[5]); await pg.check('#kCut'); await pg.click('#addKpi'); await pg.wait_for_timeout(100)
        await pg.fill('#aName','Gateway queue building'); await pg.select_option('#aOn','oegw'); await pg.wait_for_timeout(50); await pg.select_option('#aMetric','backlog'); await pg.fill('#aVal','800'); await pg.click('#addAlert'); await pg.wait_for_timeout(100)
        await pg.screenshot(path='/tmp/designer_built.png')
        await pg.click('#saveBtn'); await pg.wait_for_timeout(200); print('save:', await pg.inner_text('#toast'))
        y = await pg.evaluate('window.__designer.toYaml()'); open('/tmp/designer_out.yaml','w').write(y)
        # undo works
        n = await pg.evaluate('window.__designer.model.alerts.length'); await pg.click('#undoBtn'); print('undo alert:', n, '->', await pg.evaluate('window.__designer.model.alerts.length'))
        # load exchange (kinds) and check nothing breaks
        await pg.select_option('#startFrom','exchange'); await pg.wait_for_timeout(300)
        print('exchange problems:', await pg.evaluate('window.__designer.check()'), '| palette kinds:', await pg.locator('[data-add^="kind:"]').count())
        await pg.click('[data-add="kind:market_maker"]'); await pg.wait_for_timeout(100)
        print('after adding a market maker kind tile:', await pg.evaluate('window.__designer.check()'), await pg.evaluate('window.__designer.model.components.slice(-1)[0]'))
        await pg.screenshot(path='/tmp/designer_exchange.png')
        # the saved system appears in the simulator
        await pg.goto(D+'admin.html'); await pg.wait_for_timeout(500)
        print('simulator has demo-flow:', await pg.locator('[data-sys="demo-flow"]').count())
        await pg.set_viewport_size({'width':420,'height':860}); await pg.goto(D+'designer.html'); await pg.wait_for_timeout(500)
        print('mobile scrollWidth', await pg.evaluate('document.documentElement.scrollWidth'))
        print('ERRORS', errs); await b.close()
asyncio.run(main())
